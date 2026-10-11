'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { ApiError, apiFetch, errorMessage } from '@/lib/api-client';
import { ACTIVE_ORG_COOKIE } from '@/lib/constants';
import { viewerRole } from '@/lib/demo';
import { useRuntimeConfig } from './RuntimeConfigProvider';

const STORAGE_KEY = 'stackradar-selected-org';

/** IANA zone name, e.g. `Europe/Oslo`; undefined where Intl cannot say. */
function browserTimezone(): string | undefined {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Persist the active org id as a cookie so that BFF routes (which only see
 * the HTTP request, not React state) can read it and forward `X-Org-Id` to
 * Express. The BFF validates membership before trusting the value.
 */
function setActiveOrgCookie(orgId: string) {
    if (typeof document === 'undefined') return;
    // 1 year, root path so it's sent on every BFF request. SameSite=Lax is
    // sufficient: this cookie carries no auth, just a hint of the active org.
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `${ACTIVE_ORG_COOKIE}=${encodeURIComponent(orgId)}; path=/; max-age=${oneYear}; samesite=lax`;
}

/**
 * Remember the active org across reloads (localStorage) and expose it to the
 * BFF (cookie). Everything that switches the active org goes through here.
 */
function persistActiveOrg(org: Organization) {
    localStorage.setItem(STORAGE_KEY, org.id);
    setActiveOrgCookie(org.id);
}

export const ORG_COLORS = ['emerald', 'blue', 'purple', 'orange', 'pink', 'cyan', 'indigo', 'rose'] as const;

export type OrgColor = (typeof ORG_COLORS)[number];

export interface Organization {
    id: string;
    name: string;
    slug: string;
    color?: OrgColor | null;
    plan: string;
    role?: string;
    /** The findings view this org's tables open on, absent a link's `?tier=` or the reader's own last choice. */
    defaultFindingTier?: 'application' | 'all';
    stripeSubscriptionStatus?: string | null;
    stripeCurrentPeriodEnd?: string | null;
    stripeCancelAt?: string | null;
}

/**
 * Whether the user can manage the org's resources — clusters, scanner keys,
 * chart repositories. Mirrors the server's `requireAdminOrOwner` gate: plain
 * members can only view, so surfaces hiding on this stay honest about what a
 * request would be allowed to do. `role` comes from `/api/users/organizations`.
 */
export function isAdminOrOwner(org: Organization | null): boolean {
    return org?.role === 'owner' || org?.role === 'admin';
}

interface OrganizationContextType {
    organization: Organization | null;
    organizations: Organization[];
    isLoading: boolean;
    error: string | null;
    retry: () => void;
    setOrganization: (org: Organization) => void;
    updateOrganization: (org: Partial<Organization> & { id: string }) => void;
    addOrganization: (org: Organization, switchTo?: boolean) => void;
}

const OrganizationContext = createContext<OrganizationContextType>({
    organization: null,
    organizations: [],
    isLoading: true,
    error: null,
    retry: () => {},
    setOrganization: () => {},
    updateOrganization: () => {},
    addOrganization: () => {},
});

export function useOrganization() {
    return useContext(OrganizationContext);
}

interface Props {
    children: React.ReactNode;
}

export function OrganizationProvider({ children }: Props) {
    const { data: session, status } = useSession();
    const { demoMode } = useRuntimeConfig();
    const pathname = usePathname();
    const onInvitePage = pathname?.startsWith('/invite/') ?? false;
    const [organization, setOrganizationState] = useState<Organization | null>(null);
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const setOrganization = useCallback((org: Organization) => {
        setOrganizationState(org);
        persistActiveOrg(org);
    }, []);

    const updateOrganization = useCallback((updates: Partial<Organization> & { id: string }) => {
        // Update the organizations list
        setOrganizations((prev) => prev.map((org) => (org.id === updates.id ? { ...org, ...updates } : org)));
        // Update the current organization if it's the one being modified
        setOrganizationState((prev) => (prev && prev.id === updates.id ? { ...prev, ...updates } : prev));
    }, []);

    const addOrganization = useCallback((org: Organization, switchTo = true) => {
        setOrganizations((prev) => [...prev, org]);

        if (switchTo) {
            setOrganizationState(org);
            persistActiveOrg(org);
        }
    }, []);

    const setupOrganization = useCallback(async () => {
        if (!session?.user?.id) return;

        setIsLoading(true);
        setError(null);

        try {
            /* First, the user's organizations. Not `useResource`: this is one
               sequence — list, and when the list is empty, set up — whose
               second step is a write, and the hook models one GET. A refused
               list (any non-2xx) falls through to setup as it always has; only
               a network failure is the provider's error. */
            const data = await apiFetch<{ organizations?: Organization[] }>('/api/users/organizations').catch(
                (err: unknown) => {
                    if (err instanceof ApiError && err.status > 0) return null;
                    throw err;
                },
            );

            if (data) {
                if (data.organizations && data.organizations.length > 0) {
                    // In the live demo the visitor owns the demo org, but the server
                    // refuses every write on it; `role` here is what decides which
                    // controls get drawn, so it is reported as `member` — the surface
                    // the server still accepts. See `viewerRole`.
                    const organizations: Organization[] = data.organizations.map((org: Organization) => ({
                        ...org,
                        role: viewerRole(org.role, demoMode),
                    }));
                    setOrganizations(organizations);

                    // Check localStorage for previously selected org
                    const savedOrgId = localStorage.getItem(STORAGE_KEY);

                    // Find saved org or default to first
                    const selectedOrg =
                        (savedOrgId && organizations.find((org) => org.id === savedOrgId)) || organizations[0]!;

                    setOrganizationState(selectedOrg);
                    setActiveOrgCookie(selectedOrg.id);
                    setIsLoading(false);
                    return;
                }
            }

            // No organizations exist, create one. The browser's time zone rides
            // along: with the request's Accept-Language it is the server's only
            // "where is this person" signal (no IP lookup), for the sign-up
            // funnel and the founder alert.
            const result = await apiFetch<{ organization: Organization }>('/api/users/setup', {
                method: 'POST',
                json: { timezone: browserTimezone() },
            });
            const newOrg = result.organization;
            setOrganizations([newOrg]);
            setOrganizationState(newOrg);
            setActiveOrgCookie(newOrg.id);
        } catch (err) {
            setError(errorMessage(err, 'Failed to set up organization'));
        } finally {
            setIsLoading(false);
        }
    }, [session?.user?.id, demoMode]);

    useEffect(() => {
        // Only run when we have a session
        if (status === 'loading') return;
        if (status === 'unauthenticated') {
            setIsLoading(false);
            return;
        }

        // On the invite page the org to join is the one in the link. A new user
        // arriving here straight from OAuth has no orgs yet, and running setup
        // would hand them a personal "<name>'s Organization" before they have
        // even clicked Accept — they'd end up in two orgs. Accepting does a full
        // navigation to `/`, where this effect runs normally and finds the org.
        if (onInvitePage) {
            setIsLoading(false);
            return;
        }

        setupOrganization();
    }, [status, onInvitePage, setupOrganization]);

    // The landing page's `?intent=upgrade-<plan>` is handled by the cloud's
    // `UpgradeIntent` (rendered by AppShell), not here.

    const retry = useCallback(() => {
        setupOrganization();
    }, [setupOrganization]);

    return (
        <OrganizationContext.Provider
            value={{
                organization,
                organizations,
                isLoading,
                error,
                retry,
                setOrganization,
                updateOrganization,
                addOrganization,
            }}
        >
            {children}
        </OrganizationContext.Provider>
    );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, MenuButton, MenuHeading, MenuItem, MenuItems, MenuSection, MenuSeparator } from '@headlessui/react';
import { ChevronsUpDown, Plus, Check, Settings, Users, CreditCard } from 'lucide-react';
import { useOrganization, useRuntimeConfig, type Organization } from '@/components/providers';
import { ORG_COLOR_CLASS } from '@/lib/org-colors';
import { planName } from '@/components/organization-settings/constants';
import type { Capabilities } from '@/lib/edition';
import { CreateOrganizationModal } from './CreateOrganizationModal';
import {
    MENU_HEADING_CLASS,
    MENU_ITEM_CLASS,
    MENU_PANEL_CLASS,
    MENU_SEPARATOR_CLASS,
    MenuRadioItem,
} from './ActionMenu';

interface OrganizationSelectorProps {
    /** Fires after the active organization is switched, not on plain navigation. */
    onOrganizationChange?: (org: Organization) => void;
    /** Fires when a link in the menu is followed — the mobile drawer closes on it. */
    onNavigate?: () => void;
}

/** One letter, like the user avatar beside it: the colour carries the identity, the letter only anchors it. */
function getOrgInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
}

/**
 * The line under the org name: the plan as it is sold ("Business plan",
 * see `planName`), or in the community edition the edition itself — there
 * is one plan and nothing to upgrade to from here.
 */
function planLine(plan: string | undefined, edition: Capabilities): string {
    return edition.billing ? `${planName(plan, edition)} plan` : 'Community edition';
}

function getOrgColor(org: Organization): string {
    // Use custom color if set, otherwise generate from name
    if (org.color && ORG_COLOR_CLASS[org.color]) {
        return ORG_COLOR_CLASS[org.color];
    }

    // Fallback: generate a consistent color based on the org name
    const colors = Object.values(ORG_COLOR_CLASS);
    const index = org.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[index % colors.length]!;
}

function OrgAvatar({ org, size }: { org: Organization; size: 'sm' | 'md' }) {
    return (
        <div
            aria-hidden
            className={`${getOrgColor(org)} ${size === 'md' ? 'size-8 text-base' : 'size-6 text-xs'} rounded-md flex items-center justify-center font-semibold shrink-0`}
        >
            {getOrgInitial(org.name)}
        </div>
    );
}

/**
 * Where the current organization is managed. These are the tabs of
 * `/org-settings` that people reach for from the sidebar; the rest (invites,
 * API keys, chart repositories) are one click further, on the page itself.
 */
const MANAGE_LINKS = [
    { label: 'Settings', href: '/org-settings', icon: Settings },
    { label: 'Members', href: '/org-settings?tab=members', icon: Users },
];
/** The cloud's: the Billing tab exists only with `edition.billing`. */
const BILLING_LINK = { label: 'Billing', href: '/org-settings?tab=billing', icon: CreditCard };

/**
 * The organization menu at the top of the sidebar. One ActionMenu with three
 * jobs, in the order they are needed: manage the organization you are in,
 * switch to another one, create a new one. Switching is a radio group —
 * `menuitemradio` with `aria-checked` — because exactly one organization is
 * active at a time; the manage links are ordinary items that navigate.
 *
 * In the community edition (`edition.multiOrg` false) there is exactly one
 * organization and no way to make another, so the menu is only the first
 * job: the switcher and "Create organization" are not drawn. Gated on the
 * capability, never on the count of organizations — one org on the cloud
 * still gets the entries.
 */
export function OrganizationSelector({ onOrganizationChange, onNavigate }: OrganizationSelectorProps) {
    const { organization, organizations, setOrganization } = useOrganization();
    const { demoMode, edition } = useRuntimeConfig();
    const pathname = usePathname();
    const [showCreateModal, setShowCreateModal] = useState(false);
    const manageLinks = edition.billing ? [...MANAGE_LINKS, BILLING_LINK] : MANAGE_LINKS;

    const handleSelect = (org: Organization) => {
        if (org.id === organization?.id) return;
        setOrganization(org);
        onOrganizationChange?.(org);
    };

    if (!organization) {
        return null;
    }

    const onSettingsPage = pathname === '/org-settings';

    return (
        <Menu as="div" className="relative">
            <MenuButton className="group flex w-full items-center gap-3 px-2 rounded-md py-2 hover:bg-surface-hover/60 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
                <OrgAvatar org={organization} size="md" />

                {/* Org Name & Plan */}
                <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-semibold text-ink truncate leading-tight">{organization.name}</p>
                    <p className="text-xs text-ink-muted leading-tight">{planLine(organization.plan, edition)}</p>
                </div>

                <ChevronsUpDown
                    aria-hidden
                    className="size-4.5 shrink-0 text-ink-muted transition-colors group-hover:text-ink-secondary"
                />
            </MenuButton>

            <MenuItems
                transition
                className={`absolute left-0 top-full z-50 mt-1 w-full origin-top-left ${MENU_PANEL_CLASS}`}
            >
                <MenuSection className="pb-1.5">
                    {/* Heading names the org so "Settings" is unambiguous when there are several. */}
                    <MenuHeading as="p" className={`${MENU_HEADING_CLASS} pt-1.5 truncate`}>
                        {organization.name}
                    </MenuHeading>
                    {manageLinks.map(({ label, href, icon: Icon }) => {
                        // Only the page-level item carries aria-current; the tab lives in
                        // the query string, which the sidebar deliberately does not read.
                        const current = onSettingsPage && href === '/org-settings';
                        return (
                            <MenuItem key={href}>
                                <Link
                                    href={href}
                                    onClick={onNavigate}
                                    aria-current={current ? 'page' : undefined}
                                    className={`${MENU_ITEM_CLASS} ${current ? 'font-semibold' : ''}`}
                                >
                                    <Icon aria-hidden className="size-4 shrink-0 text-ink-muted" />
                                    {label}
                                </Link>
                            </MenuItem>
                        );
                    })}
                </MenuSection>

                {edition.multiOrg && (
                    <>
                        <MenuSeparator className={MENU_SEPARATOR_CLASS} />

                        <MenuSection className="pb-1.5">
                            <MenuHeading as="p" className={`${MENU_HEADING_CLASS} pt-1.5`}>
                                Switch organization
                            </MenuHeading>
                            {organizations.map((org) => {
                                const isSelected = org.id === organization.id;
                                return (
                                    <MenuItem
                                        key={org.id}
                                        as={MenuRadioItem}
                                        checked={isSelected}
                                        onClick={() => handleSelect(org)}
                                        className={MENU_ITEM_CLASS}
                                    >
                                        <OrgAvatar org={org} size="sm" />
                                        <span className="flex-1 min-w-0 text-left">
                                            <span
                                                className={`block truncate leading-tight ${isSelected ? 'font-semibold' : ''}`}
                                            >
                                                {org.name}
                                            </span>
                                            <span className="block text-xs text-ink-muted leading-tight">
                                                {planLine(org.plan, edition)}
                                            </span>
                                        </span>
                                        {isSelected && (
                                            <Check aria-hidden className="ml-auto size-4 shrink-0 text-ink-muted" />
                                        )}
                                    </MenuItem>
                                );
                            })}
                        </MenuSection>
                    </>
                )}

                {/* The live demo's visitor is read-only everywhere, and a new
                    org would be the one thing not covered by the demo flag —
                    so the entry is left out rather than left to 403. */}
                {!demoMode && edition.multiOrg && (
                    <>
                        <MenuSeparator className={MENU_SEPARATOR_CLASS} />

                        <MenuItem>
                            <button
                                type="button"
                                onClick={() => setShowCreateModal(true)}
                                className={`${MENU_ITEM_CLASS} my-1.5`}
                            >
                                <Plus aria-hidden className="size-4 shrink-0 text-ink-muted" />
                                Create organization
                            </button>
                        </MenuItem>
                    </>
                )}
            </MenuItems>

            {!demoMode && edition.multiOrg && (
                <CreateOrganizationModal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} />
            )}
        </Menu>
    );
}

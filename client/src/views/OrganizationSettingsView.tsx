'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { Settings, Users, Mail, CreditCard, KeyRound, Package, Container, ListFilter, BellRing } from 'lucide-react'
import { useOrganization, useRuntimeConfig } from '@/components/providers'
import { viewerRole } from '@/lib/demo'
import { LoadingBlock, TabBar, TabPanel } from '@/components/ui'
import {
    GeneralTab,
    MembersTab,
    InvitesTab,
    ApiKeyTab,
    ChartRepositoriesTab,
    ImageOwnershipTab,
    FindingViewsTab,
    NotificationsTab,
} from '@/components/organization-settings'
import type { PlanType } from '@/components/organization-settings'
import { BillingTab } from '@/cloud'

interface OrganizationSettingsViewProps {
    /** Requested tab id; unknown or hidden ids fall back to `general`. */
    tab?: string
    onTabChange: (id: string) => void
}

export function OrganizationSettingsView({ tab, onTabChange }: OrganizationSettingsViewProps) {
    const { organization } = useOrganization()
    const { demoMode, edition } = useRuntimeConfig()
    const { data: session } = useSession()
    const [currentRole, setCurrentRole] = useState<string>('member')
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        if (!organization?.id) return

        const fetchRole = async () => {
            try {
                const response = await fetch(`/api/organizations/${organization.id}`)
                if (response.ok) {
                    const data = await response.json()
                    // The demo visitor owns the demo org but may write
                    // nothing, so every tab draws member controls (which
                    // also drops Invites, an admin-only listing).
                    setCurrentRole(viewerRole(data.role || 'member', demoMode))
                }
            } catch (err) {
                console.error('Failed to fetch role:', err)
            } finally {
                setIsLoading(false)
            }
        }

        fetchRole()
    }, [organization?.id, demoMode])

    if (!organization || isLoading) {
        return (
            <LoadingBlock label="Loading settings..." className="py-12" />
        )
    }

    const currentPlan = (organization?.plan || 'free') as PlanType
    const canManageMembers = currentRole === 'owner' || currentRole === 'admin'

    const tabs = [
        { id: 'general', name: 'General', icon: Settings },
        { id: 'members', name: 'Members', icon: Users },
        // Listing invites is admin-only on the server, so only show the tab
        // to roles that can actually use it.
        ...(canManageMembers ? [{ id: 'invites', name: 'Invites', icon: Mail }] : []),
        // The community edition's one scanner key is set on the server
        // (BOOTSTRAP_CLUSTER_API_KEY) and shown on the cluster's settings
        // page; there is nothing to mint here, so the tab is not drawn.
        ...(edition.multiCluster ? [{ id: 'api-keys', name: 'API Keys', icon: KeyRound }] : []),
        { id: 'chart-repositories', name: 'Chart Repositories', icon: Package },
        // The server lists repositories to owners and admins only; the demo
        // visitor owns the demo org and sees the tab read-only.
        ...(canManageMembers || demoMode ? [{ id: 'image-ownership', name: 'Image ownership', icon: Container }] : []),
        { id: 'finding-views', name: 'Findings views', icon: ListFilter },
        { id: 'notifications', name: 'Notifications', icon: BellRing },
        // The cloud's: plans, checkout and the portal. The community
        // edition has one plan and nothing to bill.
        ...(edition.billing ? [{ id: 'billing', name: 'Billing', icon: CreditCard }] : []),
    ]

    const resolvedTab = tab && tabs.some(t => t.id === tab) ? tab : 'general'

    return (
        <div className="space-y-6">
            <div className="border-b border-edge pb-4">
                <h1 className="text-2xl font-bold text-ink">Organization Settings</h1>
                <p className="mt-1 text-sm text-ink-muted">Manage your organization settings and team members.</p>
            </div>

            <TabBar tabs={tabs} activeTab={resolvedTab} onChange={onTabChange} label="Organization settings sections" />

            <div className="max-w-5xl">
                <TabPanel tabId="general" active={resolvedTab === 'general'}>
                    <GeneralTab orgId={organization.id} currentRole={currentRole} />
                </TabPanel>
                <TabPanel tabId="members" active={resolvedTab === 'members'}>
                    <MembersTab
                        orgId={organization.id}
                        currentRole={currentRole}
                        currentUserId={session?.user?.id ?? ''}
                    />
                </TabPanel>
                {canManageMembers && (
                    <TabPanel tabId="invites" active={resolvedTab === 'invites'}>
                        <InvitesTab orgId={organization.id} currentRole={currentRole} />
                    </TabPanel>
                )}
                {edition.multiCluster && (
                    <TabPanel tabId="api-keys" active={resolvedTab === 'api-keys'}>
                        <ApiKeyTab orgId={organization.id} currentRole={currentRole} />
                    </TabPanel>
                )}
                <TabPanel tabId="chart-repositories" active={resolvedTab === 'chart-repositories'}>
                    <ChartRepositoriesTab canManage={canManageMembers} />
                </TabPanel>
                {(canManageMembers || demoMode) && (
                    <TabPanel tabId="image-ownership" active={resolvedTab === 'image-ownership'}>
                        <ImageOwnershipTab orgId={organization.id} canManage={canManageMembers} readOnly={demoMode} />
                    </TabPanel>
                )}
                <TabPanel tabId="finding-views" active={resolvedTab === 'finding-views'}>
                    {/* In the demo `canManageMembers` is already false, so the tab is read-only there. */}
                    <FindingViewsTab orgId={organization.id} canManage={canManageMembers} />
                </TabPanel>
                <TabPanel tabId="notifications" active={resolvedTab === 'notifications'}>
                    {/* Alerts (Pro) and the weekly digest. Read-only for members and in the demo. */}
                    <NotificationsTab orgId={organization.id} canManage={canManageMembers} />
                </TabPanel>
                {edition.billing && (
                    <TabPanel tabId="billing" active={resolvedTab === 'billing'}>
                        <Suspense fallback={<LoadingBlock label="Loading billing..." className="py-12" />}>
                            <BillingTab
                                orgId={organization.id}
                                readOnly={demoMode}
                                currentPlan={currentPlan}
                                subscriptionStatus={organization.stripeSubscriptionStatus ?? null}
                                currentPeriodEnd={organization.stripeCurrentPeriodEnd ?? null}
                                cancelAt={organization.stripeCancelAt ?? null}
                            />
                        </Suspense>
                    </TabPanel>
                )}
            </div>
        </div>
    )
}

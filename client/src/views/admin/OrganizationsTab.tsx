'use client'

import { Users, Layers, Server } from 'lucide-react'
import {
    Badge,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui'
import { useTabData } from './useTabData'
import { TabShell, PlanBadge, formatMax } from './Shared'
import { formatTimeAgo, getAdminPlanLimits } from './utils'
import type { RecentOrg, OrganizationsData } from './types'

// ── OrganizationsTab ───────────────────────────────────────────────────────

export function OrganizationsTab({ refreshKey, onLoadingChange, onSelectOrg }: {
    refreshKey: number
    onLoadingChange: (v: boolean) => void
    onSelectOrg: (org: RecentOrg) => void
}) {
    const { data, isLoading, error, refetch } = useTabData<OrganizationsData>('/api/admin/organizations', refreshKey, onLoadingChange)

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data && (
                <div className="bg-surface-raised rounded-md border border-edge p-5">
                    <h2 className="text-sm font-semibold text-ink-secondary mb-4">Organizations</h2>
                    {data.recentOrgs.length === 0 ? (
                        <p className="text-sm text-ink-muted">No organizations yet.</p>
                    ) : (
                        <TableContainer variant="plain">
                            <Table aria-label="Organizations">
                                <TableHead>
                                    <TableHeader>Name</TableHeader>
                                    <TableHeader>Plan</TableHeader>
                                    <TableHeader align="end" hideBelow="md">Members</TableHeader>
                                    <TableHeader align="end" hideBelow="sm">SBOMs</TableHeader>
                                    <TableHeader align="end" hideBelow="md">Clusters</TableHeader>
                                    <TableHeader align="end" hideBelow="lg">Created</TableHeader>
                                </TableHead>
                                <TableBody>
                                    {data.recentOrgs.map((org) => (
                                        <TableRow
                                            key={org.id}
                                            className="group"
                                            onClick={() => onSelectOrg(org)}
                                        >
                                            <TableCell>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        onSelectOrg(org)
                                                    }}
                                                    className="text-left cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                                >
                                                    <span className="block text-xs sm:text-sm font-medium text-ink group-hover:text-accent break-words">{org.name}</span>
                                                    <span className="block text-xs text-ink-muted font-mono break-all">{org.slug}</span>
                                                </button>
                                            </TableCell>
                                            <TableCell>
                                                <span className="inline-flex flex-wrap items-center gap-1.5">
                                                    <PlanBadge plan={org.plan} />
                                                    {org.demo && <Badge variant="info">demo</Badge>}
                                                </span>
                                            </TableCell>
                                            <TableCell align="end" hideBelow="md" className="text-ink-secondary">
                                                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                                    <Users className="size-3 text-ink-faint" />
                                                    {org.memberCount}
                                                    <span className="text-ink-muted">/ {formatMax(getAdminPlanLimits(org.plan).members)}</span>
                                                </span>
                                            </TableCell>
                                            <TableCell align="end" hideBelow="sm" className="text-ink-secondary">
                                                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                                    <Layers className="size-3 text-ink-faint" />
                                                    {org.sbomCount}
                                                    <span className="text-ink-muted">/ {formatMax(getAdminPlanLimits(org.plan).sboms)}</span>
                                                </span>
                                            </TableCell>
                                            <TableCell align="end" hideBelow="md" className="text-ink-secondary">
                                                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                                    <Server className="size-3 text-ink-faint" />
                                                    {org.clusterCount}
                                                    <span className="text-ink-muted">/ {formatMax(getAdminPlanLimits(org.plan).clusters)}</span>
                                                </span>
                                            </TableCell>
                                            <TableCell align="end" hideBelow="lg" className="text-xs text-ink-muted whitespace-nowrap">{formatTimeAgo(org.createdAt)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </div>
            )}
        </TabShell>
    )
}

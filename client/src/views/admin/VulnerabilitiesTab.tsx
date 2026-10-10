'use client'

import { Ban, Globe, Shield } from 'lucide-react'
import { useTabData } from './useTabData'
import { TabShell, SeverityBar, EcosystemChart, HealthTile } from './Shared'
import { formatNumber } from './utils'
import type { VulnerabilitiesData } from './types'

export function VulnerabilitiesTab({ refreshKey, onLoadingChange }: { refreshKey: number; onLoadingChange: (v: boolean) => void }) {
    const { data, isLoading, error, refetch } = useTabData<VulnerabilitiesData>('/api/admin/vulnerabilities', refreshKey, onLoadingChange)

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data && (() => {
                const { staleFindings, denormalizationDrift, advisories } = data.withdrawn
                return (
                    <div className="space-y-6">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="bg-surface-raised rounded-md border border-edge p-4">
                                <p className="text-xs text-ink-muted font-medium uppercase tracking-wide">Advisories</p>
                                <p className="text-2xl font-bold text-ink mt-0.5">{formatNumber(data.vulnerabilities.total)}</p>
                                <p className="text-xs text-ink-muted mt-1">Unique CVE / OSV / GHSA records the matcher can use — one row per advisory ID, {formatNumber(data.vulnerabilities.withdrawn)} withdrawn excluded</p>
                            </div>
                            <div className="bg-surface-raised rounded-md border border-edge p-4">
                                <p className="text-xs text-ink-muted font-medium uppercase tracking-wide">Affected Package Entries</p>
                                <p className="text-2xl font-bold text-ink mt-0.5">{formatNumber(data.vulnerabilities.affectedPackagesTotal)}</p>
                                <p className="text-xs text-ink-muted mt-1">Package-version entries linked to advisories — one advisory can affect many packages across ecosystems. Withdrawn entries excluded</p>
                            </div>
                        </div>

                        <div className="bg-surface-raised rounded-md border border-edge p-5">
                            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                                <h2 className="text-sm font-semibold text-ink-secondary flex items-center gap-2">
                                    <Ban className="size-4 text-ink-faint" />
                                    Withdrawn Advisories
                                </h2>
                                <span className="text-xs text-ink-muted">Excluded from every figure on this tab</span>
                            </div>
                            <p className="text-xs text-ink-muted mt-1 mb-4">
                                The matcher never matches against a retracted advisory — but nothing retracts a match made before the withdrawal.
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <HealthTile
                                    label="Stale findings"
                                    value={staleFindings.links}
                                    tone={staleFindings.links > 0 ? 'bad' : 'good'}
                                    detail={staleFindings.links > 0
                                        ? `Shown to customers right now — ${formatNumber(staleFindings.components)} components, ${formatNumber(staleFindings.advisories)} retracted advisories`
                                        : 'No finding points at a retracted advisory'}
                                />
                                <HealthTile
                                    label="Denormalization drift"
                                    value={denormalizationDrift}
                                    tone={denormalizationDrift > 0 ? 'bad' : 'good'}
                                    detail={denormalizationDrift > 0
                                        ? 'Affected-package rows still flagged matchable — the matcher index is serving them'
                                        : 'Every affected-package row agrees with its advisory'}
                                />
                                <HealthTile
                                    label="Retracted in mirror"
                                    value={advisories}
                                    tone="neutral"
                                    detail="Advisories OSV has withdrawn since we synced them"
                                />
                            </div>
                        </div>

                        <div className="bg-surface-raised rounded-md border border-edge p-5">
                            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-4">
                                <h2 className="text-sm font-semibold text-ink-secondary">Severity Distribution</h2>
                                {data.vulnerabilities.total > 0 && (
                                    <span className="text-xs text-ink-muted">
                                        {formatNumber(data.vulnerabilities.total - data.vulnerabilities.withoutCvssScore)} of{' '}
                                        {formatNumber(data.vulnerabilities.total)} carry a CVSS score
                                    </span>
                                )}
                            </div>
                            <SeverityBar bySeverity={data.vulnerabilities.bySeverity} total={data.vulnerabilities.total} />
                            {/* Two different absences, and the bar can only draw one of
                                them. `Unknown` is "no severity level"; the figure below is
                                "no CVSS score". They are counted independently — an
                                advisory can carry a level derived from a vendor string
                                with no CVSS vector behind it — so neither contains the
                                other, and reading the unknown bar as mirror coverage is
                                the mistake this line exists to prevent. */}
                            {data.vulnerabilities.total > 0 && (
                                <p className="text-xs text-ink-muted mt-3 pt-3 border-t border-edge">
                                    <span className="font-medium text-ink-secondary">Unknown</span> counts advisories with no
                                    severity <em>level</em>. Separately,{' '}
                                    <span className="font-medium text-ink-secondary">
                                        {formatNumber(data.vulnerabilities.withoutCvssScore)}
                                    </span>{' '}
                                    ({((data.vulnerabilities.withoutCvssScore / data.vulnerabilities.total) * 100).toFixed(1)}%)
                                    carry no CVSS <em>score</em> — the ceiling on how much of the mirror can be ranked
                                    numerically. An empty database and a mirror OSV has published no scores for read the same
                                    on the bar; they do not read the same here.
                                </p>
                            )}
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div className="bg-surface-raised rounded-md border border-edge p-5">
                                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-4">
                                    <h2 className="text-sm font-semibold text-ink-secondary flex items-center gap-2">
                                        <Globe className="size-4 text-ink-faint" />
                                        Ecosystem Distribution
                                    </h2>
                                    <span className="text-xs text-ink-muted">Top 15 by affected package entries</span>
                                </div>
                                <EcosystemChart entries={data.ecosystemDistribution} />
                            </div>

                            <div className="bg-surface-raised rounded-md border border-edge p-5">
                                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-4">
                                    <h2 className="text-sm font-semibold text-ink-secondary flex items-center gap-2">
                                        <Shield className="size-4 text-ink-faint" />
                                        Advisory ID Distribution
                                    </h2>
                                    <span className="text-xs text-ink-muted">Top 20 by advisory count</span>
                                </div>
                                <EcosystemChart entries={data.advisoryIdDistribution} />
                            </div>
                        </div>
                    </div>
                )
            })()}
        </TabShell>
    )
}

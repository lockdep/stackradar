'use client';

import { useState } from 'react';
import { Package, Bug, CheckCircle, ChevronDown, ExternalLink } from 'lucide-react';
import {
    VulnerabilityBadge,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui';
import { SourceTables, KeyHint, ErrorBox, LoadingBox } from './Shared';
import { formatTimeAgo } from './utils';
import { useExplorerFetch } from './explorerShared';
import type { ExplorerComponentDetailData, ExplorerComponentVulnerability } from './types';

// ── Level 4: component detail with matched vulnerabilities ───────────────────

export function ExplorerComponentDetail({ componentId }: { componentId: string }) {
    const { data, isLoading, error } = useExplorerFetch<ExplorerComponentDetailData>(
        `/api/admin/explorer/components/${componentId}`,
    );
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const toggle = (id: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    if (isLoading) return <LoadingBox />;
    if (error) return <ErrorBox message={error} />;
    if (!data) return null;

    const { component, vulnerabilities } = data;

    return (
        <div className="space-y-5">
            <div className="bg-surface-raised rounded-md border border-edge p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                            <Package className="size-4 text-ink-faint" />
                            <h2 className="text-lg font-semibold text-ink break-all">
                                {component.groupName ? `${component.groupName} / ` : ''}
                                {component.name}
                            </h2>
                            {component.version && (
                                <span className="text-sm font-mono text-ink-muted">{component.version}</span>
                            )}
                            {component.isDirect && (
                                <span className="text-[10px] uppercase tracking-wide text-accent bg-accent-subtle px-1 py-0.5 rounded-sm">
                                    direct
                                </span>
                            )}
                        </div>
                        {component.purl && (
                            <p className="text-xs text-ink-muted font-mono break-all">{component.purl}</p>
                        )}
                        {component.cpe && (
                            <p className="text-xs text-ink-muted font-mono break-all mt-0.5">{component.cpe}</p>
                        )}
                        <p className="mt-1.5">
                            <KeyHint column="components.id" value={component.id} />
                        </p>
                    </div>
                    <SourceTables tables={['components']} />
                </div>
            </div>

            <div className="bg-surface-raised rounded-md border border-edge p-5">
                <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                    <h3 className="text-sm font-semibold text-ink-secondary flex items-center gap-2">
                        <Bug className="size-4 text-ink-faint" />
                        Matched Vulnerabilities
                        <span className="text-xs font-normal text-ink-muted">({vulnerabilities.length})</span>
                    </h3>
                    <SourceTables tables={['component_vulnerabilities', 'vulnerabilities']} />
                </div>
                {vulnerabilities.length === 0 ? (
                    <p className="text-sm text-success flex items-center gap-1.5">
                        <CheckCircle className="size-4" /> No vulnerabilities matched to this component.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {vulnerabilities.map((v) => (
                            <VulnRow
                                key={v.id}
                                vuln={v}
                                isExpanded={expanded.has(v.id)}
                                onToggle={() => toggle(v.id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * What the matcher recorded when it decided this match.
 *
 * The Affected Packages table below lists every `affected[]` entry the advisory
 * published — often one per distro branch, disagreeing on the fixed version.
 * This block is the only place that says which of them actually won, because it
 * is read straight from `component_vulnerabilities` rather than re-derived from
 * the advisory. When the fix version here disagrees with every row in that
 * table, that is the finding, not a rendering bug.
 */
function MatchProvenance({ vuln }: { vuln: ExplorerComponentVulnerability }) {
    const facts: { label: string; value: string }[] = [];

    if (vuln.matchedEcosystem) facts.push({ label: 'Ecosystem', value: vuln.matchedEcosystem });
    if (vuln.matchedFixedVersion) facts.push({ label: 'Fixed in', value: vuln.matchedFixedVersion });
    if (vuln.upstreamName) {
        facts.push({
            label: 'Via source package',
            value: vuln.upstreamVersion ? `${vuln.upstreamName} @ ${vuln.upstreamVersion}` : vuln.upstreamName,
        });
    }

    if (facts.length === 0) return null;

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-2">
                <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">Match</p>
                <SourceTables tables={['component_vulnerabilities']} />
            </div>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                {facts.map((f) => (
                    <div key={f.label} className="flex items-baseline gap-1.5">
                        <dt className="text-ink-muted">{f.label}</dt>
                        <dd className="font-mono text-ink-secondary">{f.value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function VulnRow({
    vuln,
    isExpanded,
    onToggle,
}: {
    vuln: ExplorerComponentVulnerability;
    isExpanded: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="border border-edge rounded-md overflow-hidden">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={isExpanded}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-btn-secondary-hover cursor-pointer text-left"
            >
                <ChevronDown
                    className={`size-4 text-ink-faint shrink-0 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                />
                <span className="font-mono text-xs sm:text-sm font-medium text-ink shrink-0">{vuln.vulnId}</span>
                {vuln.severityLevel && <VulnerabilityBadge severity={vuln.severityLevel} />}
                {vuln.cvssScore != null && (
                    <span className="text-xs text-ink-muted shrink-0">CVSS {vuln.cvssScore.toFixed(1)}</span>
                )}
                {/* The summary and the provenance chip give way on phones —
                    the id and severity are the row; the rest is in the
                    expanded body one tap away. */}
                <span className="hidden sm:block text-sm text-ink-muted truncate flex-1 min-w-0">
                    {vuln.summary ?? ''}
                </span>
                {vuln.matchedBy && (
                    <span className="hidden md:inline text-[10px] uppercase tracking-wide text-ink-muted bg-surface-hover px-1.5 py-0.5 rounded-sm shrink-0 ml-auto">
                        {[vuln.matchedBy, vuln.matchType, vuln.matchConfidence].filter(Boolean).join(' · ')}
                    </span>
                )}
            </button>

            {isExpanded && (
                <div className="px-4 py-4 border-t border-edge bg-surface-muted/50 space-y-4">
                    {vuln.details && <p className="text-sm text-ink-secondary whitespace-pre-wrap">{vuln.details}</p>}

                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-ink-muted">
                        <KeyHint column="vulnerabilities.id" value={vuln.id} />
                        {vuln.publishedAt && <span>Published {formatTimeAgo(vuln.publishedAt)}</span>}
                        {vuln.modifiedAt && <span>Modified {formatTimeAgo(vuln.modifiedAt)}</span>}
                        {vuln.aliases.length > 0 && (
                            <span className="font-mono">Aliases: {vuln.aliases.join(', ')}</span>
                        )}
                    </div>

                    <MatchProvenance vuln={vuln} />

                    <div>
                        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-2">
                            <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
                                Affected Packages
                            </p>
                            <SourceTables tables={['vulnerability_affected_packages']} />
                        </div>
                        {vuln.affectedPackages.length === 0 ? (
                            <p className="text-xs text-ink-muted">No affected-package entries recorded.</p>
                        ) : (
                            <TableContainer variant="plain">
                                <Table density="condensed" aria-label="Affected packages">
                                    <TableHead>
                                        <TableHeader hideBelow="sm">Ecosystem</TableHeader>
                                        <TableHeader>Package</TableHeader>
                                        <TableHeader hideBelow="md">Affected range</TableHeader>
                                        <TableHeader>Fixed</TableHeader>
                                    </TableHead>
                                    <TableBody>
                                        {vuln.affectedPackages.map((ap, i) => (
                                            <TableRow key={i}>
                                                <TableCell hideBelow="sm" className="text-xs text-ink-secondary">
                                                    {ap.ecosystem ?? '—'}
                                                </TableCell>
                                                <TableCell className="text-xs font-mono text-ink-secondary break-all">
                                                    {ap.packageName}
                                                </TableCell>
                                                <TableCell
                                                    hideBelow="md"
                                                    className="text-xs font-mono text-ink-secondary"
                                                >
                                                    {formatRanges(ap)}
                                                </TableCell>
                                                <TableCell className="text-xs font-mono text-success">
                                                    {ap.fixedVersion ?? '—'}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        )}
                    </div>

                    {vuln.references.length > 0 && (
                        <div>
                            <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
                                References
                            </p>
                            <ul className="space-y-1">
                                {vuln.references.slice(0, 8).map((r, i) => (
                                    <li key={i}>
                                        <a
                                            href={r.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-xs text-accent hover:underline inline-flex items-center gap-1 break-all"
                                        >
                                            <ExternalLink className="size-3 shrink-0" /> {r.url}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Render a compact affected-range string from OSV range events / explicit versions.
function formatRanges(ap: {
    versions: string[];
    ranges: { events: { introduced?: string; fixed?: string; last_affected?: string }[] }[];
}): string {
    const parts: string[] = [];
    for (const range of ap.ranges ?? []) {
        let introduced: string | null = null;
        for (const ev of range.events ?? []) {
            if (ev.introduced != null) introduced = ev.introduced === '0' ? '0' : ev.introduced;
            if (ev.fixed != null) {
                parts.push(`>=${introduced ?? '0'} <${ev.fixed}`);
                introduced = null;
            } else if (ev.last_affected != null) {
                parts.push(`>=${introduced ?? '0'} <=${ev.last_affected}`);
                introduced = null;
            }
        }
        if (introduced != null) parts.push(`>=${introduced}`);
    }
    if (parts.length === 0 && ap.versions?.length) {
        return ap.versions.length > 5
            ? `${ap.versions.slice(0, 5).join(', ')} +${ap.versions.length - 5}`
            : ap.versions.join(', ');
    }
    return parts.length > 0 ? parts.join(', ') : '—';
}

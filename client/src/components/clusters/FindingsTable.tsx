'use client';

import {
    RiskChip,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    VulnerabilityBadge,
} from '@/components/ui';
import { formatDate } from '@/utils/formatters';
import { EpssCell } from './VulnerabilitySignalCells';
import type { ClusterRadarScoreFinding } from '@/types/cluster';
import { vulnTitle } from '@/lib/vuln-title';

/**
 * One finding per row — an advisory on a package in one image — in the same
 * column vocabulary as the cluster Vulnerabilities tab (severity, EPSS, KEV,
 * fix), plus the two things that tab's per-advisory rows fold away: which
 * package, and what the finding contributes to the image's Radar Score.
 *
 * Shared by every place that lists an image's findings (the Radar Score tab's
 * expanded image today), so the reader meets one table, not one per tab.
 * Nested by design: no container and no header fill, so it sits on the
 * expanded row's tinted backdrop without adding a third surface.
 */
export function FindingsTable({
    findings,
    'aria-label': ariaLabel,
}: {
    findings: ClusterRadarScoreFinding[];
    'aria-label': string;
}) {
    return (
        <Table aria-label={ariaLabel} density="condensed">
            <TableHead filled={false}>
                {/* A phone keeps the advisory, its severity and what it
                    contributes; the package comes back at `md`, the four
                    ranking inputs at `lg` — the contribution already sums
                    them, and the row's OSV link has the rest. */}
                <TableHeader>Vulnerability</TableHeader>
                <TableHeader>Severity</TableHeader>
                <TableHeader hideBelow="md">Package</TableHeader>
                <TableHeader hideBelow="lg">CVSS</TableHeader>
                <TableHeader hideBelow="lg">EPSS</TableHeader>
                <TableHeader hideBelow="lg">KEV</TableHeader>
                <TableHeader hideBelow="lg">Fix</TableHeader>
                <TableHeader align="end">Contribution</TableHeader>
            </TableHead>
            <TableBody>
                {findings.map((f) => (
                    <TableRow key={`${f.vulnId}|${f.packageName}|${f.packageVersion ?? ''}`}>
                        <TableCell>
                            <a
                                href={`https://osv.dev/vulnerability/${f.vulnId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                title={
                                    f.summary
                                        ? `${vulnTitle(f.summary)}\n\nView ${f.vulnId} on OSV.dev`
                                        : `View ${f.vulnId} on OSV.dev`
                                }
                                className="font-mono text-xs font-medium text-accent hover:underline break-all"
                            >
                                {f.vulnId}
                            </a>
                        </TableCell>
                        <TableCell>
                            {f.severity ? (
                                <VulnerabilityBadge severity={f.severity} />
                            ) : (
                                <span className="text-ink-muted">—</span>
                            )}
                        </TableCell>
                        <TableCell hideBelow="md" className="font-mono text-xs break-all">
                            <span className="text-ink">{f.packageName}</span>
                            {f.packageVersion && <span className="text-ink-muted">@{f.packageVersion}</span>}
                        </TableCell>
                        <TableCell hideBelow="lg" className="text-xs tabular-nums">
                            {f.cvssScore == null ? (
                                <span className="text-ink-muted" title="No CVSS base score on record">
                                    —
                                </span>
                            ) : (
                                <span className="text-ink-secondary" title="CVSS base score">
                                    {f.cvssScore.toFixed(1)}
                                </span>
                            )}
                        </TableCell>
                        <TableCell hideBelow="lg" className="text-xs tabular-nums">
                            <EpssCell score={f.epssScore} />
                        </TableCell>
                        <TableCell hideBelow="lg" className="text-xs whitespace-nowrap">
                            <KevDateCell finding={f} />
                        </TableCell>
                        <TableCell hideBelow="lg" className="font-mono text-xs">
                            {f.fixedVersion ? (
                                <span className="text-success" title={`Fixed in ${f.fixedVersion}`}>
                                    {f.fixedVersion}
                                </span>
                            ) : (
                                <span className="text-ink-muted" title="No fix version stated for this package">
                                    —
                                </span>
                            )}
                        </TableCell>
                        <TableCell align="end">
                            <RiskChip
                                score={f.riskScore}
                                title={`${f.vulnId} adds ${Math.round(f.riskScore ?? 0)} to this image’s share`}
                            />
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

/**
 * KEV with the catalogue fact inline — there is no further row to expand
 * here, so the listing date (and ransomware use) is the whole story.
 */
function KevDateCell({ finding: f }: { finding: ClusterRadarScoreFinding }) {
    if (!f.kevListedAt) {
        return (
            <span className="text-ink-muted" title="Not on the CISA Known Exploited Vulnerabilities catalogue">
                —
            </span>
        );
    }
    const title = [
        `Listed by CISA ${formatDate(f.kevListedAt)}`,
        f.kevDueDate ? `remediation due ${formatDate(f.kevDueDate)}` : null,
        f.kevRansomware === 'Known' ? 'known ransomware campaign use' : null,
    ]
        .filter(Boolean)
        .join(' · ');
    return (
        <span className="font-medium text-danger" title={title}>
            {formatDate(f.kevListedAt)}
            {f.kevRansomware === 'Known' && <span aria-hidden="true"> ·&nbsp;ransomware</span>}
        </span>
    );
}

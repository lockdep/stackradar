'use client';

import { Crosshair, GitCompareArrows, Link2, ShieldQuestion } from 'lucide-react';
import { TableContainer, Table, TableHead, TableBody, TableHeader, TableRow, TableCell } from '@/components/ui';
import { useTabData } from './useTabData';
import { TabShell, DistributionBar, HealthTile, type BarSegment } from './Shared';
import { formatNumber } from './utils';
import { UNRECORDED, type MatcherQualityData } from './types';

/**
 * Colour is per category and fixed here, not derived from rank, so a segment
 * keeps its colour when the proportions move. That is the whole point of the
 * panel: two loads of this tab are meant to be comparable by eye.
 *
 * `unrecorded` is deliberately the same neutral in all three — it is the same
 * fact each time (this link predates the column), not a fourth kind of match.
 */
const UNRECORDED_SEGMENT = { key: UNRECORDED, label: 'Unrecorded', className: 'bg-edge-strong' };

const CONFIDENCE_SEGMENTS = [
    { key: 'exact', label: 'Exact', className: 'bg-success-emphasis' },
    { key: 'fuzzy', label: 'Fuzzy', className: 'bg-attention-emphasis' },
    { key: 'unconfirmed', label: 'Unconfirmed', className: 'bg-neutral-emphasis' },
    UNRECORDED_SEGMENT,
];

const MATCH_TYPE_SEGMENTS = [
    { key: 'direct', label: 'Direct', className: 'bg-accent-emphasis' },
    { key: 'indirect', label: 'Indirect (upstream)', className: 'bg-info-emphasis' },
    UNRECORDED_SEGMENT,
];

const MATCHED_BY_SEGMENTS = [
    { key: 'purl', label: 'PURL', className: 'bg-accent-emphasis' },
    { key: 'cpe', label: 'CPE', className: 'bg-info-emphasis' },
    { key: 'name_version', label: 'Name + version', className: 'bg-attention-emphasis' },
    UNRECORDED_SEGMENT,
];

/**
 * Fold a distribution into segments, appending anything the known list does not
 * name.
 *
 * The extras matter more than the knowns: a value the matcher started writing
 * that this file has never heard of is exactly the kind of change worth seeing,
 * and silently dropping it would make the bar lie about its own total.
 */
function toSegments(
    known: Array<{ key: string; label: string; className: string }>,
    counts: Record<string, number>,
): BarSegment[] {
    const named = new Set(known.map((s) => s.key));
    const extras = Object.keys(counts)
        .filter((k) => !named.has(k))
        .sort()
        .map((k) => ({ key: k, label: k, className: 'bg-neutral-emphasis', count: counts[k] ?? 0 }));

    return [...known.map((s) => ({ ...s, count: counts[s.key] ?? 0 })), ...extras];
}

function Panel({
    icon: Icon,
    title,
    hint,
    children,
}: {
    icon: React.ElementType;
    title: string;
    hint: string;
    children: React.ReactNode;
}) {
    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5">
            <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-semibold text-ink-secondary flex items-center gap-2">
                    <Icon className="size-4 text-ink-faint" />
                    {title}
                </h2>
            </div>
            <p className="text-xs text-ink-muted mb-4">{hint}</p>
            {children}
        </div>
    );
}

export function MatcherTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const { data, isLoading, error, refetch } = useTabData<MatcherQualityData>(
        '/api/admin/matcher',
        refreshKey,
        onLoadingChange,
    );

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data &&
                (() => {
                    const { total, ecosystemAgreement: eco } = data;

                    if (total === 0) {
                        return (
                            <div className="bg-surface-raised rounded-md border border-edge p-8 text-center">
                                <p className="text-sm text-ink-muted">
                                    No matches recorded yet. These figures describe links in
                                    <span className="font-mono text-xs"> component_vulnerabilities</span>, so they
                                    appear once an SBOM has been scanned.
                                </p>
                            </div>
                        );
                    }

                    const exact = data.byMatchConfidence['exact'] ?? 0;
                    const unrecordedProvenance = data.byMatchType[UNRECORDED] ?? 0;
                    // Only pairs the question could actually be asked of. Putting the
                    // unaskable ones in the denominator would let an ecosystem we have
                    // no mapping for quietly improve the score.
                    const comparable = eco.agreeing + eco.disagreeing;

                    return (
                        <div className="space-y-6">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <HealthTile
                                    label="Matches"
                                    value={total}
                                    tone="neutral"
                                    detail="Links in component_vulnerabilities — the denominator for every figure here"
                                />
                                <HealthTile
                                    label="Exact version verdicts"
                                    value={`${((exact / total) * 100).toFixed(1)}%`}
                                    // Not a defect threshold — plenty of ecosystems have no
                                    // comparator and can never reach `exact`. It is a
                                    // baseline: what matters is this number moving, which
                                    // is what a rewrite regression looks like.
                                    tone={exact / total >= 0.7 ? 'good' : exact / total >= 0.4 ? 'warn' : 'bad'}
                                    detail={`${formatNumber(exact)} compared under a real comparator for the ecosystem`}
                                />
                                <HealthTile
                                    label="Ecosystem crossings"
                                    value={eco.disagreeing}
                                    tone={eco.disagreeing > 0 ? 'bad' : 'good'}
                                    detail={
                                        eco.disagreeing > 0
                                            ? `${((eco.disagreeing / Math.max(comparable, 1)) * 100).toFixed(2)}% of ${formatNumber(comparable)} comparable — an advisory attached to the wrong kind of package`
                                            : `Every one of ${formatNumber(comparable)} comparable matches stayed inside its ecosystem`
                                    }
                                />
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                <Panel
                                    icon={Crosshair}
                                    title="Match confidence"
                                    hint="How sure the version comparison was. `fuzzy` means a comparison had to guess; `unconfirmed` means the package matched but no version verdict was reachable."
                                >
                                    <DistributionBar
                                        segments={toSegments(CONFIDENCE_SEGMENTS, data.byMatchConfidence)}
                                        total={total}
                                        emptyMessage="No matches recorded"
                                    />
                                </Panel>

                                <Panel
                                    icon={GitCompareArrows}
                                    title="Match type"
                                    hint="Whether the component matched on its own identity, or via the source package named by its upstream= qualifier. The indirect path does materially more work, so its share is worth watching."
                                >
                                    <DistributionBar
                                        segments={toSegments(MATCH_TYPE_SEGMENTS, data.byMatchType)}
                                        total={total}
                                        emptyMessage="No matches recorded"
                                    />
                                </Panel>

                                <Panel
                                    icon={Link2}
                                    title="Matched by"
                                    hint="Which identity carried the match. A rising name+version share means PURLs are not arriving, or not parsing."
                                >
                                    <DistributionBar
                                        segments={toSegments(MATCHED_BY_SEGMENTS, data.byMatchedBy)}
                                        total={total}
                                        emptyMessage="No matches recorded"
                                    />
                                </Panel>

                                <Panel
                                    icon={ShieldQuestion}
                                    title="Ecosystem agreement"
                                    hint="Does the advisory's ecosystem describe the same kind of package as the component's PURL type? matching/ecosystem.ts maps each OSV family to exactly one PURL type, so this has a right answer."
                                >
                                    <DistributionBar
                                        segments={[
                                            {
                                                key: 'agreeing',
                                                label: 'Agreeing',
                                                count: eco.agreeing,
                                                className: 'bg-success-emphasis',
                                            },
                                            {
                                                key: 'disagreeing',
                                                label: 'Crossed',
                                                count: eco.disagreeing,
                                                className: 'bg-danger-emphasis',
                                            },
                                            {
                                                key: 'unresolvable',
                                                label: 'Not comparable',
                                                count: eco.unresolvable,
                                                className: 'bg-neutral-emphasis',
                                            },
                                            {
                                                key: 'unrecorded',
                                                label: 'Unrecorded',
                                                count: eco.unrecorded,
                                                className: 'bg-edge-strong',
                                            },
                                        ]}
                                        total={eco.agreeing + eco.disagreeing + eco.unresolvable + eco.unrecorded}
                                        emptyMessage="No matches recorded"
                                    />
                                    {/* The two grey segments are not defects and must not be
                                    read as ones — an OSV family outside the table
                                    (GitHub Actions, Linux, OSS-Fuzz) or a component with
                                    no parseable PURL simply cannot be asked this
                                    question. Saying so here is cheaper than a legend
                                    that implies otherwise. */}
                                    <p className="text-xs text-ink-muted mt-3">
                                        <span className="font-medium text-ink-secondary">Not comparable</span> — an OSV
                                        family with no PURL type in the table, or a component with no parseable PURL.{' '}
                                        <span className="font-medium text-ink-secondary">Unrecorded</span> — matched
                                        before
                                        <span className="font-mono"> matched_ecosystem</span> existed
                                        {unrecordedProvenance > 0 &&
                                            `; ${formatNumber(unrecordedProvenance)} links carry no provenance at all`}
                                        . Neither is a defect; both shrink to zero once every SBOM has been rescanned.
                                    </p>
                                </Panel>
                            </div>

                            {eco.topDisagreements.length > 0 && (
                                <div className="bg-surface-raised rounded-md border border-edge p-5">
                                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-1">
                                        <h2 className="text-sm font-semibold text-ink-secondary">Crossed ecosystems</h2>
                                        <span className="text-xs text-ink-muted">
                                            Top {formatNumber(eco.topDisagreements.length)} of{' '}
                                            {formatNumber(eco.disagreeing)} crossed matches
                                        </span>
                                    </div>
                                    <p className="text-xs text-ink-muted mb-4">
                                        Each row is an advisory family attached to a component of a type it is never
                                        published for — the shape of a match-key or release-scoping leak. Invisible per
                                        component: the Explorer shows one match at a time, where a single crossed pair
                                        reads as a curiosity.
                                    </p>
                                    <TableContainer variant="plain">
                                        <Table aria-label="Crossed ecosystem pairs">
                                            <TableHead>
                                                <TableHeader>Advisory family</TableHeader>
                                                <TableHeader hideBelow="sm">Published for</TableHeader>
                                                <TableHeader>Attached to</TableHeader>
                                                <TableHeader align="end">Matches</TableHeader>
                                            </TableHead>
                                            <TableBody>
                                                {eco.topDisagreements.map((d) => (
                                                    <TableRow key={`${d.family}:${d.componentPurlType}`}>
                                                        <TableCell className="text-xs font-mono text-ink-secondary">
                                                            {d.family}
                                                        </TableCell>
                                                        <TableCell
                                                            hideBelow="sm"
                                                            className="text-xs font-mono text-ink-muted"
                                                        >
                                                            {d.expectedPurlType}
                                                        </TableCell>
                                                        <TableCell className="text-xs font-mono text-danger">
                                                            {d.componentPurlType}
                                                        </TableCell>
                                                        <TableCell
                                                            align="end"
                                                            className="text-xs font-medium text-ink-secondary"
                                                        >
                                                            {formatNumber(d.count)}
                                                        </TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                </div>
                            )}
                        </div>
                    );
                })()}
        </TabShell>
    );
}

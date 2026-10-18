'use client';

import { useState, useEffect } from 'react';
import { Search, Package, Boxes, Trash2, Clock } from 'lucide-react';
import {
    Badge,
    Button,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
    TableEmpty,
} from '@/components/ui';
import { SourceTables, SevCounts, ErrorBox, LoadingBox } from './Shared';
import { useTabData } from './useTabData';
import { useRuntimeConfig } from '@/components/providers';
import { formatNumber, formatTimeAgo } from './utils';
import type { AdminImage, AdminImageState, AdminImageSort, AdminImagesData } from './types';
import { PAGE_SIZE } from '@/lib/constants';
import { shortDigest } from '@/utils/containerUtils';

/**
 * The state filter, and the order it reads in.
 *
 * Orphaned first: it is the only one of the three with a deadline attached, and
 * the tab exists largely because nothing else on the platform could show it.
 */
const STATES: Array<{ id: AdminImageState; label: string; hint: string }> = [
    {
        id: 'orphaned',
        label: 'Orphaned',
        hint: 'No workload_containers row anywhere. The GC collects these once they have been unreferenced for the retention window.',
    },
    {
        id: 'awaiting_sbom',
        label: 'Awaiting SBOM',
        hint: 'Running somewhere, but nothing has uploaded an SBOM for the digest yet — the ingest backlog.',
    },
    {
        id: 'scanned',
        label: 'Scanned',
        hint: 'Running, with an SBOM. The steady state.',
    },
];

const SORTS: Array<{ id: AdminImageSort; label: string }> = [
    { id: 'lastSeen', label: 'Last seen' },
    { id: 'firstSeen', label: 'First seen' },
    { id: 'repository', label: 'Repository' },
];

function StateBadge({ state }: { state: AdminImageState }) {
    if (state === 'orphaned') return <Badge variant="attention">orphaned</Badge>;
    if (state === 'awaiting_sbom') return <Badge variant="info">awaiting SBOM</Badge>;
    return <Badge variant="success">scanned</Badge>;
}

/**
 * How long an orphaned image has before the GC reaches it.
 *
 * "Due" rather than a negative number once the cutoff has passed: the sweep is
 * nightly and batch-limited, so an image past its cutoff has not been collected
 * *yet*, and "-3d" would read as though something were broken.
 */
function GcCountdown({
    image,
    retentionDays,
    multiOrg,
}: {
    image: AdminImage;
    retentionDays: number;
    multiOrg: boolean;
}) {
    if (image.gcInDays === null) return <span className="text-ink-faint">—</span>;
    if (image.gcInDays <= 0) {
        return (
            <span
                className="inline-flex items-center gap-1 text-xs text-attention"
                title="Past the cutoff — the next nightly sweep will collect it, subject to its batch limit"
            >
                <Trash2 className="size-3" /> Due
            </span>
        );
    }
    return (
        <span
            className="inline-flex items-center gap-1 text-xs text-ink-muted"
            title={
                multiOrg
                    ? `Collected once last_seen_at is older than the owning org's plan history window (${retentionDays}-day floor). The countdown already accounts for the org's plan.`
                    : `Collected once last_seen_at is older than ${retentionDays} days.`
            }
        >
            <Clock className="size-3 text-ink-faint" /> {image.gcInDays}d
        </span>
    );
}

/**
 * Where a digest runs, as one cell: how many containers reference it. An
 * image belongs to one cluster and one org (ADR 0006), so there is no second
 * figure to show — the org count this cell used to carry could only ever be 1.
 */
function UsageCell({ image }: { image: AdminImage }) {
    if (image.containerCount === 0) {
        return <span className="text-xs text-ink-faint">Nowhere</span>;
    }
    return (
        <span
            className="inline-flex items-center gap-1 text-xs text-ink-secondary whitespace-nowrap"
            title="workload_containers rows referencing this image"
        >
            <Boxes className="size-3 text-ink-faint" /> {formatNumber(image.containerCount)}
        </span>
    );
}

export function ImagesTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const [state, setState] = useState<AdminImageState | null>(null);
    const [sort, setSort] = useState<AdminImageSort>('lastSeen');
    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [offset, setOffset] = useState(0);
    // Plans decide the retention window only where there are plans.
    const { multiOrg } = useRuntimeConfig().edition;

    useEffect(() => {
        const t = setTimeout(() => {
            setDebounced(search);
            setOffset(0);
        }, 300);
        return () => clearTimeout(t);
    }, [search]);

    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), sort });
    if (state) params.set('state', state);
    if (debounced.trim()) params.set('search', debounced.trim());
    const url = `/api/admin/images?${params.toString()}`;

    const { data, isLoading, error } = useTabData<AdminImagesData>(url, refreshKey, onLoadingChange);

    // Kept from the last successful load so the filter chips do not blank out
    // and re-flow while a filtered page is in flight.
    const totals = data?.stateTotals;
    const allTotal = totals ? totals.orphaned + totals.awaiting_sbom + totals.scanned : null;

    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5">
            <div className="flex items-start justify-between gap-4 mb-1 flex-wrap">
                <div>
                    <h2 className="text-sm font-semibold text-ink-secondary">Images</h2>
                    <p className="text-xs text-ink-muted mt-0.5 max-w-2xl">
                        Every digest in the database, whoever runs it. Unlike the Explorer this starts from{' '}
                        <span className="font-mono">images</span> rather than <span className="font-mono">sboms</span>,
                        so unscanned and unreferenced rows survive — they are the two the other views cannot show.
                    </p>
                </div>
                <SourceTables tables={['images', 'sboms', 'workload_containers']} />
            </div>

            <div className="flex items-center justify-between gap-4 mt-4 mb-4 flex-wrap">
                <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                        type="button"
                        onClick={() => {
                            setState(null);
                            setOffset(0);
                        }}
                        className={`text-xs px-2 py-1 rounded-md cursor-pointer transition-colors ${state === null ? 'bg-surface-hover text-ink font-medium' : 'text-ink-muted hover:text-ink hover:bg-surface-hover'}`}
                    >
                        All{allTotal !== null && <span className="text-ink-faint"> {formatNumber(allTotal)}</span>}
                    </button>
                    {STATES.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            title={s.hint}
                            onClick={() => {
                                setState(s.id);
                                setOffset(0);
                            }}
                            className={`text-xs px-2 py-1 rounded-md cursor-pointer transition-colors ${state === s.id ? 'bg-surface-hover text-ink font-medium' : 'text-ink-muted hover:text-ink hover:bg-surface-hover'}`}
                        >
                            {s.label}
                            {totals && <span className="text-ink-faint"> {formatNumber(totals[s.id])}</span>}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <select
                        value={sort}
                        onChange={(e) => {
                            setSort(e.target.value as AdminImageSort);
                            setOffset(0);
                        }}
                        aria-label="Sort images"
                        className="text-sm border border-edge rounded-md px-2 py-1.5 bg-surface-raised text-ink-secondary cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent-emphasis/30"
                    >
                        {SORTS.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.label}
                            </option>
                        ))}
                    </select>
                    <div className="relative">
                        <Search className="size-4 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search digest, repo or registry…"
                            className="pl-8 pr-3 py-1.5 text-sm border border-edge rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-accent-emphasis/30 focus:border-accent-emphasis"
                        />
                    </div>
                </div>
            </div>

            {isLoading ? (
                <LoadingBox />
            ) : error ? (
                <ErrorBox message={error} />
            ) : data ? (
                <>
                    <TableContainer variant="plain">
                        <Table aria-label="Images">
                            <TableHead>
                                <TableHeader>Image</TableHeader>
                                <TableHeader>State</TableHeader>
                                <TableHeader hideBelow="sm">Deployed</TableHeader>
                                <TableHeader align="end" hideBelow="xl">
                                    Components
                                </TableHeader>
                                <TableHeader>Findings</TableHeader>
                                <TableHeader align="end" hideBelow="xl">
                                    Last seen
                                </TableHeader>
                                <TableHeader align="end" hideBelow="md">
                                    GC
                                </TableHeader>
                            </TableHead>
                            {data.images.length === 0 ? (
                                <TableEmpty colSpan={7}>No images match.</TableEmpty>
                            ) : (
                                <TableBody>
                                    {data.images.map((i) => (
                                        <TableRow key={i.id}>
                                            <TableCell>
                                                <span
                                                    className="block text-xs sm:text-sm font-medium text-ink truncate max-w-40 sm:max-w-md"
                                                    title={i.repository ?? undefined}
                                                >
                                                    {i.repository ?? i.registry ?? 'Unknown'}
                                                </span>
                                                <span
                                                    className="block text-xs text-ink-muted font-mono truncate max-w-40 sm:max-w-md"
                                                    title={i.digest}
                                                >
                                                    {i.registry && i.repository ? `${i.registry} · ` : ''}
                                                    {shortDigest(i.digest)}
                                                </span>
                                            </TableCell>
                                            <TableCell>
                                                <StateBadge state={i.state} />
                                            </TableCell>
                                            <TableCell hideBelow="sm">
                                                <UsageCell image={i} />
                                            </TableCell>
                                            <TableCell align="end" hideBelow="xl" className="text-ink-secondary">
                                                {i.sbomId ? (
                                                    <span className="inline-flex items-center gap-1 justify-end">
                                                        <Package className="size-3 text-ink-faint" />{' '}
                                                        {formatNumber(i.componentCount)}
                                                    </span>
                                                ) : (
                                                    <span className="text-xs text-ink-faint">No SBOM</span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                {/* Null is not zero: nobody has matched this image, so
                                                    "None" would be a claim we have not earned. */}
                                                {i.findings === null ? (
                                                    <span className="text-xs text-ink-faint">Not scanned</span>
                                                ) : (
                                                    <SevCounts counts={i.findings} />
                                                )}
                                            </TableCell>
                                            <TableCell
                                                align="end"
                                                hideBelow="xl"
                                                className="text-xs text-ink-muted whitespace-nowrap"
                                            >
                                                {formatTimeAgo(i.lastSeenAt)}
                                            </TableCell>
                                            <TableCell align="end" hideBelow="md">
                                                <GcCountdown
                                                    image={i}
                                                    retentionDays={data.retentionDays}
                                                    multiOrg={multiOrg}
                                                />
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                    </TableContainer>

                    <div className="flex items-center justify-between mt-4 text-sm text-ink-muted flex-wrap gap-2">
                        <span>
                            {data.total === 0 ? '0' : `${offset + 1}–${Math.min(offset + PAGE_SIZE, data.total)}`} of{' '}
                            {formatNumber(data.total)}
                            <span className="text-ink-faint">
                                {' '}
                                {multiOrg
                                    ? `· collected once unreferenced past the org's plan window (${data.retentionDays}-day floor)`
                                    : `· collected once unreferenced for ${data.retentionDays} days`}
                            </span>
                        </span>
                        {data.total > PAGE_SIZE && (
                            <div className="flex gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={offset === 0}
                                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                                >
                                    Prev
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={offset + PAGE_SIZE >= data.total}
                                    onClick={() => setOffset(offset + PAGE_SIZE)}
                                >
                                    Next
                                </Button>
                            </div>
                        )}
                    </div>
                </>
            ) : null}
        </div>
    );
}

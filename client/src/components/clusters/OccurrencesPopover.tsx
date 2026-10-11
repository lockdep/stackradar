'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { TriangleAlert } from 'lucide-react';
import { EntityIcon, Spinner } from '@/components/ui';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { shortDigest } from '@/utils/containerUtils';
import type { PackageOccurrences } from '@/types/cluster';

/** One linked line of the popover: an image or a running container behind the count. */
export type OccurrenceRow = {
    key: string;
    href: string;
    /** Picks the icon, and monospaces the secondary line for images. */
    kind: 'image' | 'container';
    primary: string;
    secondary: string;
};

type Props<TData> = {
    count: number;
    /** Accessible name of the count button — say what the count is of. */
    ariaLabel: string;
    /** BFF URL answering in whatever shape `rows` can map. */
    url: string;
    heading: string;
    emptyNote: string;
    /** Lead-in of the failure line; the error message follows it. */
    errorNote?: string;
    /** Maps the fetched payload to the rows the popover draws. */
    rows: (data: TData) => OccurrenceRow[];
};

/**
 * A count cell that opens to the things it counts — the images or containers
 * behind one row's spread, each a link to its detail page. The Packages and
 * Charts tabs render their count cells with this;
 * only the endpoint, the wording and the row mapping differ.
 *
 * The occurrence list is fetched when the popover opens, not with the table:
 * the tables page over large sets, and eagerly resolving every row's
 * occurrences would multiply the page query by its own row count.
 */
export function OccurrencesPopover<TData>({
    count,
    ariaLabel,
    url,
    heading,
    emptyNote,
    errorNote = 'Could not load occurrences.',
    rows,
}: Props<TData>) {
    return (
        <Popover className="relative inline-block">
            <PopoverButton
                className="cursor-pointer tabular-nums text-accent hover:underline focus:outline-none focus-visible:underline"
                aria-label={ariaLabel}
            >
                {count}
            </PopoverButton>
            <PopoverPanel
                anchor="bottom end"
                transition
                className="z-50 w-80 [--anchor-gap:4px] rounded-md border border-edge bg-surface-raised p-1 shadow-floating transition data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in"
            >
                <OccurrencesList url={url} heading={heading} emptyNote={emptyNote} errorNote={errorNote} rows={rows} />
            </PopoverPanel>
        </Popover>
    );
}

/**
 * Mounted only while the popover is open, so mount effect = open = fetch.
 * Closing unmounts and drops the state; reopening fetches fresh.
 */
function OccurrencesList<TData>({
    url,
    heading,
    emptyNote,
    errorNote,
    rows,
}: Pick<Props<TData>, 'url' | 'heading' | 'emptyNote' | 'rows'> & { errorNote: string }) {
    const [fetched, setFetched] = useState<{
        data: TData | null;
        error: string | null;
    } | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        apiFetch<TData>(url, { signal: controller.signal })
            .then((data) => setFetched({ data, error: null }))
            .catch((err) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                setFetched({ data: null, error: errorMessage(err, 'Failed to load') });
            });
        return () => controller.abort();
    }, [url]);

    if (!fetched) {
        return (
            <div className="flex items-center justify-center gap-2 px-2 py-3 text-xs text-ink-muted">
                <Spinner size="sm" className="text-ink-faint" />
                Loading…
            </div>
        );
    }

    if (fetched.error || !fetched.data) {
        return (
            <p className="flex items-start gap-1.5 px-2 py-2 text-xs text-attention">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {errorNote} {fetched.error}
            </p>
        );
    }

    const items = rows(fetched.data);

    return (
        <div className="max-h-80 overflow-y-auto">
            <p className="truncate px-2 pb-1 pt-1.5 text-xs font-semibold text-ink-muted" title={heading}>
                {heading}
            </p>
            {items.length === 0 ? (
                <EmptyNote>{emptyNote}</EmptyNote>
            ) : (
                items.map((row) => (
                    <Link
                        key={row.key}
                        href={row.href}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover"
                    >
                        <EntityIcon kind={row.kind === 'image' ? 'image' : 'container'} />
                        <span className="min-w-0">
                            <span className="block truncate text-xs font-medium text-ink">{row.primary}</span>
                            <span
                                className={`block truncate ${row.kind === 'image' ? 'font-mono ' : ''}text-[10px] text-ink-muted`}
                            >
                                {row.secondary}
                            </span>
                        </span>
                    </Link>
                ))
            )}
        </div>
    );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
    return <p className="px-2 py-2 text-xs text-ink-muted">{children}</p>;
}

/**
 * Rows for the package and vulnerability occurrence endpoints, which share
 * one shape. With `withCluster` the secondary line leads with the cluster
 * name, since on an org-wide list that is the first thing the reader wants
 * to know about a hit; a cluster tab already knows, and its rows say only
 * what the tab does not.
 */
export function occurrenceRows(
    data: PackageOccurrences,
    kind: 'images' | 'containers',
    { withCluster }: { withCluster: boolean },
): OccurrenceRow[] {
    const prefix = (clusterName: string) => (withCluster ? `${clusterName} · ` : '');
    if (kind === 'images') {
        return data.images.map((image) => ({
            key: image.id,
            href: `/images/${image.id}`,
            kind: 'image' as const,
            primary: image.repository ?? image.digest,
            secondary: `${prefix(image.clusterName)}${shortDigest(image.digest)}`,
        }));
    }
    return data.workloads.map((workload) => ({
        key: workload.containerId,
        href: `/clusters/${workload.clusterId}/containers/${workload.containerId}`,
        kind: 'container' as const,
        primary: `${workload.namespaceName}/${workload.workloadName}`,
        secondary: `${prefix(workload.clusterName)}${workload.workloadKind ?? 'Unknown kind'}`,
    }));
}

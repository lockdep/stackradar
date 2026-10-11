'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
    ExposureDuration,
    KevBadge,
    LoadingBlock,
    PackageIcon,
    SeverityDelta,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui';
import { useResource } from '@/hooks';
import type { MovementFinding, MovementFindingsResponse, MovementImage } from '@/types/feed';
import { FixLine, type FixIndex } from './fix-hints';
import { movementQuery, type MovementFilters } from './movement-query';

/** Packages an unfolded row shows before asking; the server hands back at most a hundred findings. */
const PACKAGES_PREVIEW = 6;
/** Advisory ids a package line names before asking. */
const IDS_PREVIEW = 4;
const BANDS = ['critical', 'high', 'medium', 'low'] as const;
type Band = (typeof BANDS)[number];

/**
 * One of the two lists under an unfolded row. Two header-only tables stacked
 * flush read as one table with a stray header row, so the unfolded area takes
 * the page's muted ground and each list is its own card on it, under a quiet
 * caption saying what it lists and how many.
 */
export function UnfoldedSection({
    title,
    count,
    noun,
    children,
}: {
    title: string;
    count?: number;
    noun: [string, string];
    children: React.ReactNode;
}) {
    return (
        <section className="[&+&]:mt-4">
            <h3 className="mb-1.5 text-xs font-medium text-ink">
                {title}
                {count !== undefined && (
                    <span className="font-normal text-ink-muted">
                        {' '}
                        · {count.toLocaleString()} {count === 1 ? noun[0] : noun[1]}
                    </span>
                )}
            </h3>
            {children}
        </section>
    );
}

/** What arrived on one package version: one upgrade, however many advisories it answers. */
type PackageGroup = {
    key: string;
    packageName: string;
    packageType: string;
    packageVersion: string | null;
    /** Every fix version the advisories state, lowest first as strings; usually one. */
    fixedVersions: string[];
    counts: Record<Band, number>;
    kev: number;
    /** Worst first — the server's order, kept. */
    findings: MovementFinding[];
};

/** The arrivals folded per package version, in the order the worst finding of each first appears. */
function groupByPackage(findings: MovementFinding[]): PackageGroup[] {
    const groups = new Map<string, PackageGroup>();
    for (const f of findings) {
        const key = `${f.packageType}|${f.packageName}|${f.packageVersion ?? ''}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                key,
                packageName: f.packageName,
                packageType: f.packageType,
                packageVersion: f.packageVersion,
                fixedVersions: [],
                counts: { critical: 0, high: 0, medium: 0, low: 0 },
                kev: 0,
                findings: [],
            };
            groups.set(key, group);
        }
        group.findings.push(f);
        const band = (f.severityLevel ?? '').toLowerCase();
        if ((BANDS as readonly string[]).includes(band)) group.counts[band as Band]++;
        if (f.kevListed) group.kev++;
        if (f.fixedVersion && !group.fixedVersions.includes(f.fixedVersion)) group.fixedVersions.push(f.fixedVersion);
    }
    return [...groups.values()];
}

/**
 * What arrived on one image in the block's window, by package, and how to fix
 * it. Worst first: the server orders the findings, and a package takes the
 * place of its worst one.
 */
export function MovementFindings({
    image,
    href,
    filters,
    fixIndex,
    releaseIds,
    onOpenVulnerability,
}: {
    image: MovementImage;
    href: string;
    filters: MovementFilters;
    fixIndex: FixIndex;
    releaseIds: readonly (string | null)[];
    onOpenVulnerability: (vulnId: string) => void;
}) {
    const [all, setAll] = useState(false);
    /* The unfold asks for the bands the block shows; whose image it is was
       decided by the row being here at all. */
    const query = movementQuery({ ...filters, control: 'all' });
    const { data, error } = useResource<MovementFindingsResponse>(
        `/api/feed/movement/${image.imageId}/findings?${query}`,
        { fallbackError: 'Could not load the findings that arrived' },
    );
    const groups = useMemo(() => groupByPackage(data?.findings ?? []), [data]);

    const section = (body: React.ReactNode, count?: number) => (
        <UnfoldedSection title="What arrived" count={count} noun={['finding', 'findings']}>
            {body}
        </UnfoldedSection>
    );

    if (!data && !error) return section(<LoadingBlock label="Listing what arrived..." className="py-2" />);
    if (error && !data) return section(<p className="py-1 text-xs text-ink-muted">{error}</p>);
    if (!data) return null;

    if (data.findings.length === 0) {
        return section(
            <p className="py-1 text-xs text-ink-muted">
                {data.unmeasuredMoves > 0
                    ? 'The findings came with a new image whose previous digest is no longer known, so they cannot be listed here.'
                    : 'The events for this image do not name the findings that arrived.'}{' '}
                <Link href={href} className="text-accent hover:underline">
                    See every finding on the image page
                </Link>
                .
            </p>,
        );
    }

    const shown = all ? groups : groups.slice(0, PACKAGES_PREVIEW);
    const hidden = groups.length - shown.length;
    const cut = data.total > data.findings.length;
    const packageFixes = groups.flatMap((g) => g.fixedVersions.map((v) => `${g.packageName} ${v}`));

    return section(
        <>
            <TableContainer square>
                <Table aria-label="Findings that arrived on this image, by package" density="condensed" textSize="xs">
                    <TableHead>
                        <TableHeader>Package</TableHeader>
                        <TableHeader className="whitespace-nowrap">Installed → fixed in</TableHeader>
                        <TableHeader>Arrived</TableHeader>
                        {/* Nested under an indented row, so it has less width
                            than its parent: the ids return at `sm`, the cause
                            at `lg`. */}
                        <TableHeader hideBelow="sm" className="w-full">
                            Vulnerabilities
                        </TableHeader>
                        <TableHeader hideBelow="lg">How it arrived</TableHeader>
                    </TableHead>
                    <TableBody>
                        {shown.map((group) => (
                            <PackageGroupRow key={group.key} group={group} onOpenVulnerability={onOpenVulnerability} />
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                {(hidden > 0 || all) && (
                    <button
                        type="button"
                        onClick={() => setAll((v) => !v)}
                        className="cursor-pointer text-accent hover:underline"
                    >
                        {all
                            ? 'Show fewer'
                            : `Show ${hidden.toLocaleString()} more ${hidden === 1 ? 'package' : 'packages'}`}
                    </button>
                )}
                {/* Either the server cut the list or the events did not carry
                    every finding; both mean the image page is the whole story. */}
                {(cut || data.partial) && (
                    <span>
                        Not every arrival could be listed here.{' '}
                        <Link href={href} className="text-accent hover:underline">
                            See every finding on the image page
                        </Link>
                        .
                    </span>
                )}
            </div>
            <div className="mt-3">
                <FixLine
                    index={fixIndex}
                    imageId={image.imageId}
                    releaseIds={releaseIds}
                    thirdParty={image.control == null ? null : image.control === 'third-party'}
                    packageFixes={packageFixes}
                    imageHref={href}
                />
            </div>
        </>,
        data.total,
    );
}

/** One package version and everything that arrived on it: the upgrade, what it answers, and the ids behind it. */
function PackageGroupRow({
    group,
    onOpenVulnerability,
}: {
    group: PackageGroup;
    onOpenVulnerability: (vulnId: string) => void;
}) {
    const [all, setAll] = useState(false);
    const ids = all ? group.findings : group.findings.slice(0, IDS_PREVIEW);
    const hidden = group.findings.length - ids.length;
    const vias = new Set(group.findings.map((f) => f.via));
    /* The longest presence among the scan arrivals: how long the package has
       been running before the advisory database caught up with it. */
    const present = group.findings
        .filter((f) => f.via === 'scan' && f.presentSince)
        .sort((a, b) => (a.presentSince! < b.presentSince! ? -1 : 1))[0];

    return (
        <TableRow>
            {/* The ids column takes the slack (`w-full`), so the name holds its line from `sm` up. */}
            <TableCell className="break-all align-top sm:break-normal sm:whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5 font-mono text-ink">
                    <PackageIcon purlType={group.packageType} className="size-3.5 shrink-0 text-ink-muted" />
                    {group.packageName}
                </span>
            </TableCell>
            <TableCell className="align-top font-mono whitespace-nowrap">
                <span className="text-ink-secondary">{group.packageVersion ?? '—'}</span>
                <span className="text-ink-muted"> → </span>
                {group.fixedVersions.length > 0 ? (
                    <span className="text-success">{group.fixedVersions.join(', ')}</span>
                ) : (
                    <span
                        className="font-sans text-ink-muted"
                        title="No advisory states a fix version for this package"
                    >
                        no fix stated
                    </span>
                )}
            </TableCell>
            <TableCell className="align-top">
                <span className="inline-flex items-center gap-1.5">
                    <SeverityDelta sign="+" counts={group.counts} noun="arrived" compact />
                    <KevBadge count={group.kev} />
                </span>
            </TableCell>
            <TableCell hideBelow="sm" className="align-top">
                <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {ids.map((f) => (
                        <FindingId key={f.key} finding={f} onOpen={() => onOpenVulnerability(f.vulnId)} />
                    ))}
                    {(hidden > 0 || all) && group.findings.length > IDS_PREVIEW && (
                        <button
                            type="button"
                            onClick={() => setAll((v) => !v)}
                            className="cursor-pointer text-accent hover:underline"
                        >
                            {all ? 'fewer' : `+${hidden.toLocaleString()} more`}
                        </button>
                    )}
                </span>
            </TableCell>
            <TableCell hideBelow="lg" className="align-top text-ink-muted whitespace-nowrap">
                {vias.size > 1
                    ? 'Advisory updates and a new image'
                    : vias.has('move')
                      ? 'New image'
                      : 'Advisory update'}
                {/* A scan arrival was already there; say for how long. */}
                {present?.presentSince && (
                    <>
                        {' · running for '}
                        <ExposureDuration
                            since={present.presentSince}
                            isLowerBound={present.presentSinceIsLowerBound}
                            reason={present.lowerBoundReason}
                        />
                    </>
                )}
            </TableCell>
        </TableRow>
    );
}

const BAND_DOT: Record<Band, string> = {
    critical: 'bg-sev-critical-emphasis',
    high: 'bg-sev-high-emphasis',
    medium: 'bg-sev-medium-emphasis',
    low: 'bg-sev-low-emphasis',
};

/** One advisory id under a package line: its band as a dot, the id opening the vulnerability dialog. */
function FindingId({ finding, onOpen }: { finding: MovementFinding; onOpen: () => void }) {
    /* The overview resolves the id as written — a GHSA whose identity is its
       CVE lands on the CVE's overview. */
    const href = `/vulnerabilities/${encodeURIComponent(finding.vulnId)}`;
    const band = (finding.severityLevel ?? '').toLowerCase();
    const dot = (BANDS as readonly string[]).includes(band) ? BAND_DOT[band as Band] : 'bg-ink-faint';
    return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            {/* A plain click opens the dialog; a modifier click or middle
                click is the browser's, and lands on the page in a new tab. */}
            <Link
                href={href}
                onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpen();
                }}
                title={`${finding.vulnId} — ${band || 'unscored'}${finding.kevListed ? ', on CISA KEV' : ''}. What it is and everything running it.`}
                className="font-mono text-ink-secondary hover:text-accent hover:underline"
            >
                {finding.vulnId}
            </Link>
        </span>
    );
}

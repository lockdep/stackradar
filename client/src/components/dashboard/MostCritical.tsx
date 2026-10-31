'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronRight, ExternalLink, ShieldAlert } from 'lucide-react';
import {
    LoadingBlock,
    PackageIcon,
    RiskInputsLine,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
    TierLensEmpty,
    VulnerabilityBadge,
} from '@/components/ui';
import { AffectedImagesTable, ExploitationCell, FixCell, VulnerabilityDialog } from '@/components/clusters';
import { type ControlFilter } from '@/lib/image-control';
import { SHOWN_DESPITE_LENS_LABEL, TIER_LENS_HINT, withTierParam, type TierLens } from '@/lib/tier-lens';
import type { ClusterVulnerabilitiesResponse } from '@/types/cluster';
import { type FixIndex } from './fix-hints';
import { vulnTitle } from '@/lib/vuln-title';

type Vulnerability = ClusterVulnerabilitiesResponse['vulnerabilities'][number];
/** The two filters every request of the block carries. */
export type MostCriticalFilters = { lens: TierLens; control: ControlFilter };

type LensChip = Exclude<TierLens, 'all'>;

/** A query with both filters on it; `all` of either sends nothing. */
function withFilters(params: URLSearchParams, { lens, control }: MostCriticalFilters): URLSearchParams {
    if (control !== 'all') params.set('control', control);
    return withTierParam(params, lens);
}

/** How many advisories the block shows — the top of the Vulnerabilities page, not the page. */
const MOST_CRITICAL_ROWS = 3;

/** Where the block's list is read from — the page fetches it, under the scope it shares with the other block. */
export const mostCriticalUrl = (filters: MostCriticalFilters) =>
    `/api/vulnerabilities?${withFilters(new URLSearchParams({ limit: String(MOST_CRITICAL_ROWS), offset: '0' }), filters)}`;

/**
 * "Most critical" — the handful of vulnerabilities across every cluster that
 * most deserve attention, one row per advisory.
 *
 * The top of `GET /api/vulnerabilities`, in the server's order and with no
 * client-side sort: by the advisory's Risk Score, the sum of what its
 * findings add — so the block always shows exactly the rows the
 * Vulnerabilities page shows first under the same lens. "Most critical" is
 * that ranking, not the severity band: exploitation is inside each
 * contribution, so an idle critical sits below a medium under attack.
 *
 * A row leads with what the advisory is about — its own summary — and
 * carries the id under it: `GHSA-2xp9-vwfh-vxw4` tells a reader nothing,
 * "Unauthenticated remote code execution in the image optimizer" tells them
 * whether to keep reading. EPSS and KEV are one label beside the severity,
 * shown only on a row that is exploited or likely to be — on a three-row list
 * a column of "None known" says nothing; the full tables keep the pair.
 *
 * The lens (Application / Base image) is the page's, chosen in the
 * Dashboard's filter bar with whose images and the window — the block has no
 * control of its own — and exploited findings
 * list under every lens, labelled. A lens hides findings by design, so the
 * block says what it is hiding: the critical findings in the other bucket
 * (`criticalTierCounts`) are one line under the table, with the way to them.
 * Whose image the finding is in (Yours / Third-party) is the page's scope,
 * shared with "New vulnerabilities on running images".
 *
 * A row unfolds to the three things a Dashboard reader needs before acting:
 * what is known about exploitation, which version fixes it, and the images
 * carrying it — each with the move the upgrade list knows for it, or why
 * there is none. Everything else (every package version, every container,
 * how long each has been exposed) is the vulnerability's own page, one link
 * away; the block used to embed all of it, three tables deep, and listed the
 * containers twice. The id opens the vulnerability in a dialog rather than
 * on its page: every block here refetches on return.
 *
 * The list is fetched by the page (`mostCriticalUrl`), under the scope it
 * shares with the other block, and rendered only once at least one image is
 * scanned (`enabled`).
 */
export function MostCritical({
    enabled,
    data,
    error,
    isRefreshing,
    filters,
    onLensChange,
    onShowEveryImage,
    fixIndex,
    showClusterCount,
}: {
    enabled: boolean;
    data: ClusterVulnerabilitiesResponse | null;
    error: string | null;
    isRefreshing: boolean;
    filters: MostCriticalFilters;
    onLensChange: (next: TierLens) => void;
    /** Drops the page's image scope — offered when it is what emptied the block. */
    onShowEveryImage: () => void;
    fixIndex: FixIndex;
    /** The org has more than one cluster — with one, "1" on every row says nothing. */
    showClusterCount: boolean;
}) {
    const { lens, control } = filters;
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
    const [openVuln, setOpenVuln] = useState<string | null>(null);

    if (!enabled) return null;

    const vulnerabilities = data?.vulnerabilities ?? [];

    /* Keyed with the filters: the images behind a row differ per view. */
    const toggle = (key: string) =>
        setOpen((prev) => {
            const next = new Set(prev);
            if (!next.delete(key)) next.add(key);
            return next;
        });

    return (
        <section aria-labelledby="most-critical-heading" className="mt-8">
            <div className="mb-3 flex items-end justify-between gap-4">
                <div className="min-w-0">
                    <h2
                        id="most-critical-heading"
                        className="flex items-center gap-1.5 text-base font-semibold text-ink"
                    >
                        <ShieldAlert aria-hidden="true" className="size-4 text-ink-muted" />
                        <span className="flex flex-wrap items-center gap-x-1.5">
                            Most critical
                            {/* The date range above does not reach this block — it
                                ranks what is running today. Said in the same place
                                the block above says its window. */}
                            <span className="text-xs font-normal text-ink-muted">· right now</span>
                        </span>
                    </h2>
                    <p className="mt-1 text-sm text-ink-muted">
                        The vulnerabilities to look at first: the ones that add the most to your Risk Score.
                    </p>
                </div>
                <Link
                    href={`/vulnerabilities?tier=${lens}`}
                    className="inline-flex shrink-0 items-center gap-1 text-sm text-accent hover:underline"
                >
                    All vulnerabilities
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
            </div>

            {/* The page fetches as a refresh when the gate flips (the hook
                mounts with the url null), so "no data yet" is loading. */}
            {!data && !error ? (
                <LoadingBlock label="Ranking vulnerabilities..." className="py-8" />
            ) : error && !data ? (
                <p className="text-sm text-ink-muted">{error}</p>
            ) : vulnerabilities.length === 0 ? (
                <p className="rounded-md border border-edge bg-surface-raised px-4 py-3 text-sm text-ink-muted">
                    {lens !== 'all' && (data?.tierCounts?.all ?? 0) > 0 ? (
                        <TierLensEmpty lens={lens} counts={data?.tierCounts} onChange={onLensChange} />
                    ) : control !== 'all' ? (
                        <>
                            No open findings on {control === 'yours' ? 'organization' : 'third-party'} images.{' '}
                            <button
                                type="button"
                                onClick={onShowEveryImage}
                                className="cursor-pointer text-accent hover:underline"
                            >
                                Show every image
                            </button>
                        </>
                    ) : (
                        <>No open findings on any scanned image.</>
                    )}
                </p>
            ) : (
                <>
                    {/* A lens change keeps the last rows up while the new ones load; dimmed, so they are not read as the new lens's. */}
                    <TableContainer
                        variant="section"
                        className={isRefreshing ? 'opacity-60 transition-opacity' : 'transition-opacity'}
                    >
                        <Table aria-label="Most critical vulnerabilities across all clusters" density="condensed">
                            <TableHead>
                                <TableHeader srOnly className="w-8">
                                    Affected images
                                </TableHeader>
                                {/* Where it hit and Fix are columns where there is room
                                    and ride under the title where there is not, so
                                    a narrow screen loses only the exploitation column.
                                    The package is the unfolded row's — most titles
                                    already name it. */}
                                <TableHeader className="w-full">Vulnerability</TableHeader>
                                {/* Two questions, two columns: as one run of tags they
                                    read as four values of one thing. */}
                                <TableHeader hideBelow="lg">Layer</TableHeader>
                                <TableHeader hideBelow="md">Fix</TableHeader>
                                {/* Plain right-aligned counts under their own headers,
                                    widest first. Glyph-and-number pairs in one cell
                                    were neither a column nor a sentence. */}
                                {showClusterCount && (
                                    <TableHeader hideBelow="md" align="end">
                                        Clusters
                                    </TableHeader>
                                )}
                                {/* Whose images sits against how many: the owner
                                    describes the count beside it, not the advisory. */}
                                <TableHeader hideBelow="lg">Affected image built by</TableHeader>
                                <TableHeader align="end">Images</TableHeader>
                                <TableHeader hideBelow="md" align="end">
                                    Containers
                                </TableHeader>
                            </TableHead>
                            <TableBody>
                                {vulnerabilities.map((vuln) => {
                                    const key = `${control}|${lens}|${vuln.identity}`;
                                    return (
                                        <VulnerabilityRow
                                            key={key}
                                            vuln={vuln}
                                            filters={filters}
                                            fixIndex={fixIndex}
                                            showClusterCount={showClusterCount}
                                            expanded={open.has(key)}
                                            onToggle={() => toggle(key)}
                                            onOpenVulnerability={() => setOpenVuln(vuln.vulnId)}
                                        />
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </TableContainer>
                    <HiddenByLens lens={lens} counts={data?.criticalTierCounts} onLensChange={onLensChange} />
                </>
            )}
            <VulnerabilityDialog vulnId={openVuln} onClose={() => setOpenVuln(null)} />
        </section>
    );
}

/**
 * What the lens is leaving out, in the unit the severity cards below count:
 * critical findings outside the lens. Opening on Application is right —
 * it is what the reader's build controls — but three rows with one critical
 * above a card saying 340 reads as a contradiction until the block says where
 * the rest are. Silent under "every finding", and when nothing critical is
 * outside the lens.
 */
function HiddenByLens({
    lens,
    counts,
    onLensChange,
}: {
    lens: TierLens;
    counts: ClusterVulnerabilitiesResponse['criticalTierCounts'];
    onLensChange: (next: TierLens) => void;
}) {
    if (lens === 'all' || !counts) return null;
    const other: LensChip = lens === 'application' ? 'base' : 'application';
    /* Everything outside the lens — the other bucket, and the packages no
       scan has classified yet, which neither lens lists. */
    const hidden = counts.all - counts[lens];
    if (hidden <= 0) return null;
    const name: Record<LensChip, string> = { application: 'application packages', base: 'base images' };
    const unclassified = hidden - counts[other];
    return (
        <p className="mt-2 text-xs text-ink-muted">
            Ranked over {name[lens]} only.{' '}
            <span className="text-ink-secondary">
                {hidden.toLocaleString()} more critical {hidden === 1 ? 'finding is' : 'findings are'} not ranked here
            </span>
            , unless exploited: {counts[other].toLocaleString()} in {name[other]}
            {unclassified > 0 && <>, {unclassified.toLocaleString()} in packages not classified yet</>}.{' '}
            {counts[other] > 0 && (
                <>
                    <button
                        type="button"
                        onClick={() => onLensChange(other)}
                        className="cursor-pointer text-accent hover:underline"
                    >
                        Rank {name[other]}
                    </button>
                    {' · '}
                </>
            )}
            <button
                type="button"
                onClick={() => onLensChange('all')}
                className="cursor-pointer text-accent hover:underline"
            >
                Rank everything
            </button>
        </p>
    );
}

function VulnerabilityRow({
    vuln,
    filters,
    fixIndex,
    showClusterCount,
    expanded,
    onToggle,
    onOpenVulnerability,
}: {
    vuln: Vulnerability;
    filters: MostCriticalFilters;
    fixIndex: FixIndex;
    showClusterCount: boolean;
    expanded: boolean;
    onToggle: () => void;
    onOpenVulnerability: () => void;
}) {
    const { lens } = filters;
    const owner = imageOwner(vuln);
    const layer = findingLayer(vuln);
    const href = `/vulnerabilities/${encodeURIComponent(vuln.vulnId)}`;
    /* A plain click opens the dialog; a modifier click or middle click is
       the browser's, and lands on the page in a new tab. */
    const openInDialog = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onOpenVulnerability();
    };
    return (
        <Fragment>
            <TableRow onClick={onToggle} selected={expanded} aria-expanded={expanded}>
                <TableCell className="w-8 pr-0">
                    {/* The row is the tab stop (`TableRow`); the chevron stays for the pointer. */}
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        aria-label={`${expanded ? 'Hide' : 'Show'} the images ${vuln.vulnId} affects`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle();
                        }}
                        className="flex cursor-pointer rounded-sm p-0.5 hover:bg-btn-secondary-hover"
                    >
                        <ChevronRight
                            aria-hidden="true"
                            className={`size-4 text-ink-secondary transition-transform duration-100 ${
                                expanded ? 'rotate-90' : ''
                            }`}
                        />
                    </button>
                </TableCell>
                <TableCell>
                    {/* What it is, then what it is called. The row is the one
                        click target — it unfolds; the way to the dialog is the
                        link inside. An advisory with no summary of its own
                        leads with the id, as before. */}
                    {vuln.summary && (
                        <span className="line-clamp-2 text-xs font-medium text-ink" title={vuln.summary}>
                            {vulnTitle(vuln.summary)}
                        </span>
                    )}
                    <span
                        className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${vuln.summary ? 'mt-1' : ''}`}
                    >
                        <span
                            className={`font-mono break-all ${vuln.summary ? 'text-ink-muted' : 'font-medium text-ink'}`}
                        >
                            {vuln.vulnId}
                        </span>
                        <span
                            title={
                                vuln.cvssScore != null
                                    ? `CVSS base score ${vuln.cvssScore.toFixed(1)} of 10 — the worst across the records behind this row`
                                    : 'No record behind this row publishes a CVSS score'
                            }
                        >
                            <VulnerabilityBadge severity={vuln.severity ?? 'unscored'} />
                        </span>
                        {/* Exploitation is said only when there is some: "None
                            known" on every row was a column of nothing, and the
                            rows it is true of are the ones ranked first. */}
                        {vuln.exploited && (
                            <ExploitationCell epssScore={vuln.epssScore} kevListedAt={vuln.kevListedAt} />
                        )}
                        {(owner || layer) && (
                            <span className="text-ink-muted lg:hidden">
                                {[owner?.inline, layer?.inline].filter(Boolean).join(' · ')}
                            </span>
                        )}
                        {vuln.fixAvailable && (
                            <span className="md:hidden">
                                <FixCell fixAvailable />
                            </span>
                        )}
                    </span>
                    {vuln.shownDespiteTier && lens !== 'all' && (
                        <span
                            className="mt-0.5 block text-xs text-ink-muted"
                            title="Outside this view, shown because it is on CISA KEV or has EPSS ≥ 0.1"
                        >
                            {SHOWN_DESPITE_LENS_LABEL[lens]}
                        </span>
                    )}
                </TableCell>
                <TableCell hideBelow="lg" className="text-xs whitespace-nowrap text-ink-secondary">
                    {layer ? <span title={layer.title}>{layer.label}</span> : <span className="text-ink-muted">—</span>}
                </TableCell>
                <TableCell hideBelow="md" className="text-xs">
                    <FixCell fixAvailable={vuln.fixAvailable} />
                </TableCell>
                {showClusterCount && (
                    <TableCell hideBelow="md" align="end" className="text-xs tabular-nums text-ink-secondary">
                        {vuln.clusterCount.toLocaleString()}
                    </TableCell>
                )}
                <TableCell hideBelow="lg" className="text-xs whitespace-nowrap text-ink-secondary">
                    {owner ? <span title={owner.title}>{owner.label}</span> : <span className="text-ink-muted">—</span>}
                </TableCell>
                <TableCell align="end" className="text-xs font-medium tabular-nums text-ink">
                    {vuln.imageCount.toLocaleString()}
                </TableCell>
                <TableCell hideBelow="md" align="end" className="text-xs tabular-nums text-ink-secondary">
                    {/* 0 is "scanned but not in any inventory yet" — a dash, as on the full list. */}
                    {vuln.containerCount > 0 ? (
                        vuln.containerCount.toLocaleString()
                    ) : (
                        <span
                            className="text-ink-muted"
                            title="The affected images are scanned but not in any inventory yet"
                        >
                            —
                        </span>
                    )}
                </TableCell>
            </TableRow>
            {expanded && (
                <TableRow className="bg-surface-muted">
                    {/* Mounted only while unfolded, so the fetch happens on demand. */}
                    <TableCell colSpan={showClusterCount ? 8 : 7} className="pl-4 sm:pl-10">
                        <div className="space-y-4 pt-2 pb-5">
                            <Facts vuln={vuln} />
                            {/* Under the block's two filters, so the list is what the row's counts counted. */}
                            <AffectedImagesTable
                                url={`/api/vulnerabilities/occurrences?${withFilters(new URLSearchParams({ identity: vuln.identity }), filters)}`}
                                vulnId={vuln.vulnId}
                                packages={vuln.packages}
                                fixIndex={fixIndex}
                            />
                            <Link
                                href={href}
                                onClick={openInDialog}
                                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                            >
                                Every package, container and how long each has been exposed
                                <ArrowRight aria-hidden="true" className="size-3" />
                            </Link>
                        </div>
                    </TableCell>
                </TableRow>
            )}
        </Fragment>
    );
}

/**
 * Where the advisory hit, as two answers rather than one run of tags: whose
 * image, and which layer of it. Each is a set behind the row — one advisory
 * is often in an application package of one image and the base of another —
 * so each can name both, spelled out: "Both" under a header asks the reader
 * to recall the two options. The words are the filter bar's: "Organization" is
 * every image not decided third-party, as its "Organization images" scope is.
 * Null from an older server, which sends neither.
 */
/** `inline` is the phrase under the title where the columns are hidden — it has no header to lean on. */
type Where = { label: string; inline: string; title: string };

function imageOwner(vuln: Vulnerability): Where | null {
    const controls = vuln.controls ?? [];
    const organization = controls.some((c) => c !== 'third-party');
    const thirdParty = controls.includes('third-party');
    if (organization && thirdParty)
        return {
            label: 'Org + third-party',
            inline: 'Organization and third-party images',
            title: 'Running in images your organization builds and in third-party images',
        };
    if (organization)
        return {
            label: 'Organization',
            inline: 'Organization image',
            title: 'Running in images your organization builds',
        };
    if (thirdParty)
        return { label: 'Third-party', inline: 'Third-party image', title: 'Running in images someone else builds' };
    return null;
}

function findingLayer(vuln: Vulnerability): Where | null {
    const buckets = vuln.buckets ?? [];
    const application = buckets.includes('application');
    const base = buckets.includes('base');
    if (application && base)
        return {
            label: 'Application + base image',
            inline: 'Application and base image',
            title: 'In application packages and in the base image',
        };
    if (application) return { label: 'Application', inline: 'Application', title: TIER_LENS_HINT.application };
    if (base) return { label: 'Base image', inline: 'Base image', title: TIER_LENS_HINT.base };
    return null;
}

/**
 * The two lines between "what is it" (the row) and "where is it" (the
 * images): what is known about exploitation, and which version fixes it.
 * All from the row — no fetch — so the unfold opens with its answer in place.
 */
function Facts({ vuln }: { vuln: Vulnerability }) {
    /* One line per package name: the versions running, then the fix the
       advisories state for it. */
    const byName = new Map<string, { purlType: string | null | undefined; installed: string[]; fixed: string[] }>();
    for (const pkg of vuln.packages) {
        const entry = byName.get(pkg.name) ?? { purlType: pkg.purlType, installed: [], fixed: [] };
        if (pkg.version && !entry.installed.includes(pkg.version)) entry.installed.push(pkg.version);
        if (pkg.fixedVersion && !entry.fixed.includes(pkg.fixedVersion)) entry.fixed.push(pkg.fixedVersion);
        byName.set(pkg.name, entry);
    }
    const osvUrl = `https://osv.dev/vulnerability/${encodeURIComponent(vuln.vulnId)}`;

    return (
        <div className="grid max-w-4xl grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <span className="text-ink-muted">Exploitation</span>
            <RiskInputsLine
                inputs={{
                    riskScore: vuln.riskScore,
                    cvssScore: vuln.cvssScore ?? null,
                    epssScore: vuln.epssScore,
                    epssPercentile: null,
                    kevListedAt: vuln.kevListedAt,
                    kevDueDate: vuln.kevDueDate,
                    kevRansomware: vuln.kevRansomware,
                }}
            />
            {/* What is affected leads, the fix follows it: the row no longer
                names the package, so this is where a reader learns which one,
                at which versions, before what to move to. */}
            <span className="text-ink-muted">Affected</span>
            <span className="flex flex-col gap-0.5">
                {[...byName].map(([name, pkg]) => (
                    <span key={name} className="inline-flex flex-wrap items-center gap-x-1.5 font-mono">
                        <PackageIcon purlType={pkg.purlType} className="size-3.5 text-ink-muted" />
                        <span className="font-medium text-ink">{name}</span>
                        {pkg.installed.length > 0 ? (
                            <span className="text-ink-secondary" title="The versions running on your images">
                                {pkg.installed.join(', ')}
                            </span>
                        ) : (
                            <span
                                className="font-sans text-ink-muted"
                                title="The SBOM names the package without a version"
                            >
                                version not recorded
                            </span>
                        )}
                        <span className="font-sans text-ink-muted">→</span>
                        {pkg.fixed.length > 0 ? (
                            <span className="text-success">
                                <span className="font-sans">fixed in </span>
                                {pkg.fixed.join(', ')}
                            </span>
                        ) : (
                            <span
                                className="font-sans text-ink-muted"
                                title="The advisory states no fix version for this package"
                            >
                                no fix stated
                            </span>
                        )}
                    </span>
                ))}
            </span>
            <span className="text-ink-muted">Record</span>
            <a
                href={osvUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
            >
                {vuln.vulnId} on OSV.dev
                <ExternalLink aria-hidden="true" className="size-3" />
            </a>
        </div>
    );
}

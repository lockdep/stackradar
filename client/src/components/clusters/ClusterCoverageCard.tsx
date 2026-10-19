'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ChevronRight, CircleCheck, ExternalLink, KeyRound, TriangleAlert } from 'lucide-react';
import { Badge, CodeBlock, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { useRuntimeConfig } from '@/components/providers';
import { usePollWhile, useResource, useRevalidateOnFocus } from '@/hooks';
import { formatImageName, formatShortDigest } from '@/utils/formatters';
import type { ClusterCoverage } from '@/types/cluster';
import { InventoryProgress } from './InventoryProgress';
import { COVERAGE_ANCHOR } from './RegistryAuthBanner';
import { useCluster } from './ClusterContext';
import {
    classifyRow,
    createRegistrySecretCommand,
    dockerConfigHelmCommand,
    dockerConfigValuesYaml,
    groupByImage,
    pullSecretHelmCommand,
    pullSecretKnowledge,
    pullSecretsLookup,
    pullSecretValuesYaml,
    scannerInstallFor,
    STATUS_ORDER,
    type ImageGroup,
    type PullSecretKnowledge,
    type RowStatus,
    type ScannerInstall,
} from './coverageRemediation';

/* Only ever polls while something is legitimately still in flight; see the
   `usePollWhile` call below. */
const POLL_MS = 15_000;
const STALE_AFTER_MS = 60_000;

/* `useSyncExternalStore` wants a subscription; the URL hash never notifies. */
const subscribeToNothing = () => () => {};

const PRIVATE_REGISTRY_DOCS_URL = 'https://stackradar.io/docs/install/private-registries';
const WORKLOAD_IDENTITY_DOCS_URL = `${PRIVATE_REGISTRY_DOCS_URL}#workload-identity`;

function waitedFor(since: string): string {
    const ms = Date.now() - new Date(since).getTime();
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function plural(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

function RowStatusBadge({ status, host }: { status: RowStatus; host: string | null }) {
    switch (status) {
        case 'auth_failed':
            return (
                <span className="shrink-0" title={host ? `The scanner cannot authenticate to ${host}` : undefined}>
                    <Badge variant="danger">auth failed</Badge>
                </span>
            );
        case 'scan_failed':
            return (
                <span className="shrink-0" title="The scan failed — check the scanner pod logs for the full error">
                    <Badge variant="attention">scan failed</Badge>
                </span>
            );
        case 'rate_limited':
            return (
                <span
                    className="shrink-0"
                    title={host ? `${host} rate-limited the pull; the scanner retries on its own` : undefined}
                >
                    <Badge variant="neutral">rate-limited, retrying</Badge>
                </span>
            );
        default:
            return null;
    }
}

function ImageName({ group }: { group: ImageGroup }) {
    const digest = formatShortDigest(group.imageDigest);
    return (
        <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-ink-muted" title={group.imageRef}>
            <span className="truncate">{formatImageName(group.imageRef) ?? group.imageRef}</span>
            {digest && (
                <span className="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-ink-secondary">{digest}</span>
            )}
        </span>
    );
}

/** `workload/container`, or how many of them, for a folded row. */
function GroupContainers({ group }: { group: ImageGroup }) {
    const [first] = group.containers;
    if (group.containers.length === 1 && first) {
        return (
            <span className="block truncate font-medium text-ink">
                {first.workloadName}/{first.containerName}
            </span>
        );
    }
    const names = group.containers.map((c) => `${c.namespace}/${c.workloadName}/${c.containerName}`).join('\n');
    return (
        <span className="block truncate font-medium text-ink" title={names}>
            {plural(group.containers.length, 'container')}
        </span>
    );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
    return (
        <p className="text-xs text-ink-secondary">
            <span className="font-semibold text-ink">{n}.</span> {children}
        </p>
    );
}

function Label({ children }: { children: React.ReactNode }) {
    return <p className="text-[11px] font-medium tracking-wider text-ink-muted uppercase">{children}</p>;
}

function DocsLink({ href = PRIVATE_REGISTRY_DOCS_URL, children }: { href?: string; children: React.ReactNode }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
        >
            {children}
            <ExternalLink aria-hidden="true" className="size-3" />
        </a>
    );
}

function Alternative({ summary, children }: { summary: string; children: React.ReactNode }) {
    return (
        <details className="group/alt rounded-md border border-edge">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-ink-secondary hover:text-ink [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-1">
                    <ChevronRight
                        aria-hidden="true"
                        className="size-3.5 transition-transform group-open/alt:rotate-90"
                    />
                    {summary}
                </span>
            </summary>
            <div className="space-y-2 border-t border-edge p-3">{children}</div>
        </details>
    );
}

/**
 * The scanner reads the pull Secrets the affected pods already use. The
 * chart turns the names into an RBAC `resourceNames` restriction, so this
 * is the fix that grants the least: exactly those Secrets, nothing else in
 * the cluster becomes readable.
 */
function ReusePullSecrets({
    install,
    names,
    intro,
}: {
    install: ScannerInstall;
    names: string[];
    intro: React.ReactNode;
}) {
    return (
        <div className="space-y-2">
            <p className="text-xs text-ink-secondary">{intro}</p>
            <Label>Add to your values</Label>
            <CodeBlock code={pullSecretValuesYaml(install, names)} placeholders={names.length === 0} />
            <Label>Or apply with Helm</Label>
            <CodeBlock code={pullSecretHelmCommand(install, names)} placeholders />
            <ChartVersionHint install={install} />
        </div>
    );
}

/**
 * The bundled chart's version is not known here, so the command pins a
 * placeholder. Saying where to read it off is cheaper than an operator
 * discovering that an unpinned `helm upgrade` also upgraded StackRadar.
 */
function ChartVersionHint({ install }: { install: ScannerInstall }) {
    if (install.kind === 'standalone' && install.chartVersion) return null;
    return (
        <p className="text-[11px] text-ink-muted">
            <code className="font-mono">&lt;chart-version&gt;</code> is the chart version{' '}
            <code className="font-mono">helm list --namespace stackradar</code> shows; pinning it keeps this change from
            doubling as an upgrade.
        </p>
    );
}

/** The scanner gets a credential of its own, mounted as a docker config. */
function OwnCredential({ install, host }: { install: ScannerInstall; host: string | null }) {
    return (
        <div className="space-y-2">
            <Step n={1}>Create a registry Secret for the scanner, in its own namespace:</Step>
            <CodeBlock code={createRegistrySecretCommand(install, host)} placeholders />
            <Step n={2}>Point the chart at it:</Step>
            <Label>Add to your values</Label>
            <CodeBlock code={dockerConfigValuesYaml(install)} />
            <Label>Or apply with Helm</Label>
            <CodeBlock code={dockerConfigHelmCommand(install)} placeholders />
            <ChartVersionHint install={install} />
            <p className="text-[11px] text-ink-muted">
                On EKS, GKE or AKS the scanner can use workload identity instead of a stored password:{' '}
                <DocsLink href={WORKLOAD_IDENTITY_DOCS_URL}>cloud workload identity</DocsLink>.
            </p>
        </div>
    );
}

/** How many pre-filled lookup commands show before the rest fold away. */
const INLINE_LOOKUPS = 3;

function PullSecretLookups({ namespaces }: { namespaces: string[] }) {
    const inline = namespaces.slice(0, INLINE_LOOKUPS);
    const rest = namespaces.slice(INLINE_LOOKUPS);
    const block = (namespace: string) => (
        <div key={namespace} className="space-y-1">
            <p className="font-mono text-[11px] text-ink-muted">{namespace}</p>
            <CodeBlock code={pullSecretsLookup(namespace)} />
        </div>
    );
    return (
        <div className="space-y-2">
            {inline.map(block)}
            {rest.length > 0 && (
                <details className="group/more">
                    <summary className="cursor-pointer list-none text-xs font-medium text-accent hover:underline [&::-webkit-details-marker]:hidden">
                        <span className="inline-flex items-center gap-1">
                            <ChevronRight
                                aria-hidden="true"
                                className="size-3.5 transition-transform group-open/more:rotate-90"
                            />
                            {rest.length === 1 ? '1 more namespace' : `${rest.length} more namespaces`}
                        </span>
                    </summary>
                    <div className="mt-2 space-y-2">{rest.map(block)}</div>
                </details>
            )}
        </div>
    );
}

function Fix({
    knowledge,
    install,
    host,
    namespaces,
}: {
    knowledge: PullSecretKnowledge;
    install: ScannerInstall;
    host: string | null;
    namespaces: string[];
}) {
    switch (knowledge.kind) {
        case 'named': {
            const list = knowledge.names.map((n, i) => (
                <span key={n}>
                    {i > 0 && (i === knowledge.names.length - 1 ? ' and ' : ', ')}
                    <code className="font-mono text-ink">{n}</code>
                </span>
            ));
            return (
                <div className="space-y-3">
                    <ReusePullSecrets
                        install={install}
                        names={knowledge.names}
                        intro={
                            <>
                                The affected pods pull with the Secret{knowledge.names.length === 1 ? '' : 's'} {list}.
                                Let the scanner read exactly those — the chart turns the list into an RBAC{' '}
                                <code className="font-mono">resourceNames</code> restriction, so nothing else in the
                                cluster becomes readable.
                            </>
                        }
                    />
                    <Alternative summary="Rather give the scanner a credential of its own?">
                        <OwnCredential install={install} host={host} />
                    </Alternative>
                </div>
            );
        }
        case 'none':
            return (
                <div className="space-y-3">
                    <p className="text-xs text-ink-secondary">
                        The affected pods carry no pull Secret, so the node authenticates on its own — cloud workload
                        identity, or a registry attached to the cluster. The scanner has neither; give it a credential
                        of its own.
                    </p>
                    <OwnCredential install={install} host={host} />
                </div>
            );
        case 'unknown':
            return (
                <div className="space-y-3">
                    <p className="text-xs text-ink-secondary">
                        This scanner is older than the release that reports which pull Secrets its pods use, so look
                        them up — different namespaces often use different Secrets, so check each:
                    </p>
                    <PullSecretLookups namespaces={namespaces} />
                    <ReusePullSecrets
                        install={install}
                        names={[]}
                        intro={
                            <>
                                Then let the scanner read exactly those — the chart turns the list into an RBAC{' '}
                                <code className="font-mono">resourceNames</code> restriction, so nothing else in the
                                cluster becomes readable. No Secret listed on the pods? The node authenticates on its
                                own; give the scanner a credential instead (below).
                            </>
                        }
                    />
                    <Alternative summary="Give the scanner a credential of its own">
                        <OwnCredential install={install} host={host} />
                    </Alternative>
                </div>
            );
    }
}

/**
 * The failure, the images behind it and the fix, in that order and all
 * visible. The remedy ships in the scanner's Helm chart; this block's job is
 * to connect the failure to it, pre-filled wherever the inventory knows the
 * answer. One block above the table rather than a line per container,
 * because credentials are per registry, not per workload — every affected
 * image is fixed by the same upgrade.
 */
export function RegistryAuthRemediation({
    groups,
    install,
}: {
    /** The auth-failed images, as the card folded them. */
    groups: ImageGroup[];
    install: ScannerInstall;
}) {
    const containers = groups.flatMap((g) => g.containers);
    const hosts = [...new Set(groups.map((g) => g.scanErrorHost).filter((h): h is string => Boolean(h)))];
    const namespaces = [...new Set(containers.map((c) => c.namespace))];
    const knowledge = pullSecretKnowledge(containers);

    return (
        <section aria-label="Registry authentication failed" className="border-b border-edge">
            <div className="bg-danger-subtle px-5 py-3">
                <div className="flex items-start gap-2.5">
                    <KeyRound aria-hidden="true" className="mt-px size-4 shrink-0 text-danger" />
                    <div className="min-w-0 flex-1 text-xs text-danger">
                        <p className="font-medium">
                            Registry authentication failed
                            {hosts.length > 0 && (
                                <>
                                    {' · '}
                                    <span className="font-mono">{hosts.join(', ')}</span>
                                </>
                            )}
                        </p>
                        <p className="mt-1">
                            The registry rejected the scanner&apos;s pull. {plural(containers.length, 'container')} on{' '}
                            {plural(groups.length, 'image')} {containers.length === 1 ? 'has' : 'have'} no SBOM and will
                            not get one until the scanner can authenticate — waiting does not fix this, the values below
                            do.
                        </p>
                    </div>
                </div>
            </div>
            <div className="space-y-4 px-5 py-4">
                <div className="space-y-1.5">
                    <Label>Blocked images</Label>
                    <ul className="space-y-1">
                        {groups.map((g) => (
                            <li key={g.key} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                                <ImageName group={g} />
                                <span className="text-xs text-ink-muted">
                                    {plural(g.containers.length, 'container')} in{' '}
                                    <span className="font-mono">{g.namespaces.join(', ')}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="space-y-1.5">
                    <Label>How to fix</Label>
                    <Fix knowledge={knowledge} install={install} host={hosts[0] ?? null} namespaces={namespaces} />
                </div>
                <p className="text-xs text-ink-muted">
                    The scanner retries on its own; the error clears once the next scan uploads.{' '}
                    <DocsLink>Scanning private registries</DocsLink>
                </p>
            </div>
        </section>
    );
}

/**
 * Which workloads this cluster is running that StackRadar has no SBOM for —
 * and, when the scanner has said, *why*.
 *
 * The counts elsewhere answer "how complete is my coverage"; this answers
 * "which ones are missing", which is the only form of the question anyone can
 * act on. Without it a cluster that permanently fails to scan three of its
 * workloads looks identical to one that is still working through them — and a
 * vulnerability tool that quietly omits a workload is worse than one that
 * admits it cannot see it.
 */
export function ClusterCoverageCard({ clusterId, className = '' }: { clusterId: string; className?: string }) {
    const { edition } = useRuntimeConfig();
    const { cluster } = useCluster();
    const install = scannerInstallFor(edition, cluster.scannerVersion);

    /* Coverage is a secondary panel on a page that works without it. A
       failed load leaves the last good render — or nothing — rather than
       putting an error where the answer should be: the hook keeps `data`
       across a failed refetch and the error is not read. */
    const {
        data: coverage,
        isLoading,
        lastUpdated,
        refetch: revalidate,
    } = useResource<ClusterCoverage>(`/api/clusters/${clusterId}/coverage`);

    /* Classified once, and the status travels with the row — everything
       below renders worst-first, so asking "what is this one" again per row
       would be a second source of truth. */
    const rows = useMemo(() => {
        const classified = (coverage?.workloads ?? []).map((w) => ({
            workload: w,
            status: classifyRow(w),
        }));
        // Worst first; the server already ordered by oldest-discovered within
        // each group.
        return classified.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    }, [coverage]);

    const groups = useMemo(() => groupByImage(rows), [rows]);
    const authGroups = groups.filter((g) => g.status === 'auth_failed');
    const otherGroups = groups.filter((g) => g.status !== 'auth_failed');

    const count = (...statuses: RowStatus[]) => rows.filter((r) => statuses.includes(r.status)).length;
    const blockedCount = count('auth_failed');
    const failedCount = count('scan_failed', 'stuck');
    const pendingCount = count('waiting', 'rate_limited');

    /* Polls only while something can genuinely resolve on its own — waiting
       scans, and rate-limited ones the scanner is retrying. Auth failures and
       stuck rows end with an operator action, not with time, and polling them
       would be asking a backend with nothing new to say, forever. */
    usePollWhile(pendingCount > 0, revalidate, POLL_MS);
    useRevalidateOnFocus(revalidate, { lastUpdated, staleAfterMs: STALE_AFTER_MS, enabled: !isLoading });

    /* Deep-linked from the Dashboard's registry-auth banner. The card mounts
       empty and fills in after its own fetch, so the browser's hash scroll on
       navigation finds nothing to scroll to; do it once the content exists. */
    const deepLinked = useSyncExternalStore(
        subscribeToNothing,
        () => window.location.hash === `#${COVERAGE_ANCHOR}`,
        () => false,
    );
    const cardRef = useRef<HTMLDivElement>(null);
    const hasCoverage = coverage !== null && coverage.discovered !== null && coverage.scanned !== null;
    useEffect(() => {
        if (deepLinked && hasCoverage) cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, [deepLinked, hasCoverage]);

    // Nothing reported: a scanner too old to send an inventory, or not yet
    // installed. Silence beats a panel claiming zero coverage.
    if (!coverage || coverage.discovered === null || coverage.scanned === null) return null;

    const gap = coverage.workloads.length;

    return (
        <div
            id={COVERAGE_ANCHOR}
            ref={cardRef}
            className={`scroll-mt-6 rounded-md border border-edge bg-surface-raised ${className}`}
        >
            <div className="border-b border-edge px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-sm font-semibold text-ink-secondary">Coverage</h2>
                        <p className="mt-0.5 text-xs text-ink-muted">
                            Containers running in this cluster, against the ones StackRadar has an SBOM for
                        </p>
                    </div>
                    {gap === 0 && <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />}
                </div>
                <div className="mt-3">
                    <InventoryProgress
                        discovered={coverage.discovered}
                        scanned={coverage.scanned}
                        blocked={blockedCount}
                        failed={failedCount}
                    />
                </div>
            </div>

            {gap === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-ink-muted">
                    Every container the scanner can see has an SBOM.
                </p>
            ) : (
                <>
                    {authGroups.length > 0 && <RegistryAuthRemediation groups={authGroups} install={install} />}
                    {failedCount > 0 && (
                        <div className="flex items-start gap-2.5 border-b border-edge bg-attention-subtle px-5 py-3">
                            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-attention" />
                            <p className="text-xs text-attention">
                                {failedCount === 1 ? 'One container is' : `${failedCount} containers are`} failing to
                                scan, or waiting longer than an image pull and SBOM generation should take — often an
                                image pull backoff or a scan that ran out of memory. The scanner pod logs carry the full
                                error.
                            </p>
                        </div>
                    )}
                    {otherGroups.length > 0 && (
                        <Table aria-label="Containers without an SBOM">
                            <TableHead>
                                {/* The image is the first thing to go on a phone:
                                    the container cell already names the workload,
                                    the namespace and the failure. */}
                                <TableHeader className="w-1/3">Container</TableHeader>
                                <TableHeader hideBelow="sm">Image</TableHeader>
                                <TableHeader align="end" className="w-20 sm:w-28">
                                    Waiting
                                </TableHeader>
                            </TableHead>
                            <TableBody>
                                {otherGroups.map((g) => {
                                    const isFailed = g.status === 'scan_failed' || g.status === 'stuck';
                                    return (
                                        <TableRow key={g.key}>
                                            <TableCell className="w-1/3 max-w-0">
                                                <GroupContainers group={g} />
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <span className="truncate text-xs text-ink-muted">
                                                        {g.namespaces.join(', ')}
                                                    </span>
                                                    <RowStatusBadge status={g.status} host={g.scanErrorHost} />
                                                </span>
                                            </TableCell>
                                            <TableCell hideBelow="sm" className="max-w-0">
                                                <ImageName group={g} />
                                            </TableCell>
                                            <TableCell align="end" className="w-20 tabular-nums sm:w-28">
                                                <span
                                                    className={
                                                        isFailed ? 'font-medium text-attention' : 'text-ink-muted'
                                                    }
                                                >
                                                    {waitedFor(g.firstSeenAt)}
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    )}
                </>
            )}
        </div>
    );
}

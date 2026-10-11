'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ChevronRight, CircleCheck, ExternalLink, KeyRound, TriangleAlert } from 'lucide-react';
import { Badge, CodeBlock, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { usePollWhile, useResource, useRevalidateOnFocus } from '@/hooks';
import { formatImageName, formatShortDigest } from '@/utils/formatters';
import type { ClusterCoverage } from '@/types/cluster';
import { InventoryProgress } from './InventoryProgress';
import { COVERAGE_ANCHOR } from './RegistryAuthBanner';

/**
 * How long a workload may sit undiscovered-to-scanned before we stop calling it
 * "in progress".
 *
 * Image pull plus syft is minutes, not half an hour, even for a large image on
 * a slow link. Past this the honest reading is that something is wrong, and
 * saying "generating SBOMs" would be the product lying about its own coverage.
 * This heuristic is now the *fallback*: when the scanner has reported a
 * failure reason, the reason wins — an auth failure surfaces immediately,
 * because it is known and there is nothing to wait out.
 */
const STUCK_AFTER_MS = 30 * 60_000;

/* Only ever polls while something is legitimately still in flight; see the
   `usePollWhile` call below. */
const POLL_MS = 15_000;
const STALE_AFTER_MS = 60_000;

/* `useSyncExternalStore` wants a subscription; the URL hash never notifies. */
const subscribeToNothing = () => () => {};

const PRIVATE_REGISTRY_DOCS_URL = 'https://stackradar.io/docs/install/private-registries';

function waitedFor(since: string): string {
    const ms = Date.now() - new Date(since).getTime();
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

type UnscannedContainer = ClusterCoverage['workloads'][number];

/**
 * What a row without an SBOM *is*, worst first. The scanner's reported reason
 * outranks the elapsed-time heuristic — a known failure needs no 30-minute
 * wait, and a known-transient one must never be called stuck.
 */
type RowStatus = 'auth_failed' | 'scan_failed' | 'stuck' | 'waiting' | 'rate_limited';

const STATUS_ORDER: Record<RowStatus, number> = {
    auth_failed: 0,
    scan_failed: 1,
    stuck: 2,
    waiting: 3,
    rate_limited: 4,
};

function classifyRow(w: UnscannedContainer): RowStatus {
    switch (w.scanErrorCode) {
        case 'registry_auth':
            return 'auth_failed';
        case 'registry_rate_limited':
            /* Transient and self-healing via the scanner's own retry. Showing
               the credentials remediation here would be wrong and would train
               users to ignore the auth banner, so this state never joins the
               failed group. */
            return 'rate_limited';
        case null:
            return Date.now() - new Date(w.firstSeenAt).getTime() >= STUCK_AFTER_MS ? 'stuck' : 'waiting';
        default:
            /* `scan_error`, and any code a newer scanner invents: a failure
               with no specific remediation. The scanner pod's logs carry the
               detail the product deliberately does not transmit. */
            return 'scan_failed';
    }
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

/**
 * The remedy already ships in the scanner's Helm chart; this block's whole job
 * is to connect the failure to it, copy-pasteably. One block above the table
 * rather than one per row, because credentials are per registry, not per
 * workload — every affected row is fixed by the same upgrade.
 */
function RemediationStep({ n, children }: { n: number; children: React.ReactNode }) {
    return (
        <p className="text-xs text-ink-secondary">
            <span className="font-semibold text-ink">{n}.</span> {children}
        </p>
    );
}

function RemediationOption({
    n,
    title,
    whenTo,
    children,
}: {
    n: number;
    title: string;
    whenTo: string;
    children: React.ReactNode;
}) {
    return (
        <section className="min-w-0 overflow-hidden rounded-md border border-edge">
            <header className="border-b border-edge bg-surface-muted px-3 py-2">
                <div className="flex items-baseline gap-2">
                    <span className="text-[11px] font-semibold tracking-wider text-ink-muted uppercase">
                        Option {n}
                    </span>
                    <h4 className="text-xs font-semibold text-ink">{title}</h4>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-muted">{whenTo}</p>
            </header>
            <div className="space-y-2 p-3">{children}</div>
        </section>
    );
}

function OrDivider() {
    return (
        <div aria-hidden="true" className="flex items-center gap-3">
            <div className="h-px flex-1 bg-edge" />
            <span className="text-[11px] font-medium tracking-wider text-ink-faint uppercase">or</span>
            <div className="h-px flex-1 bg-edge" />
        </div>
    );
}

/** How many pre-filled lookup commands show before the rest fold away. */
const INLINE_LOOKUPS = 3;

/**
 * The `kubectl` that prints the pull Secret names of every pod in a
 * namespace. Pods, not controllers: the ServiceAccount admission plugin
 * copies a ServiceAccount's `imagePullSecrets` onto each pod at creation
 * (DigitalOcean's registry integration, for one, relies on this), so a
 * Deployment or Job template can be empty while its pods — and the scanner,
 * which reads the pod — see the Secret. Querying the template would print
 * nothing for exactly the setups this option is for.
 */
function pullSecretsLookup(namespace: string): string {
    return `kubectl get pods -n ${namespace} -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.imagePullSecrets[*].name}{"\\n"}{end}'`;
}

/**
 * Where the pods got a Secret the template never declared — and the only
 * place left to look once a finished Job's pods are gone.
 */
function serviceAccountLookup(namespace: string): string {
    return `kubectl get sa -n ${namespace} -o jsonpath='{range .items[*]}{.metadata.name}: {.imagePullSecrets[*].name}{"\\n"}{end}'`;
}

/**
 * One command per affected namespace — every pod in it shares the answer,
 * and one loop over all of them is something nobody reads. The first few
 * inline; the rest behind a fold so a wide failure does not bury step 2.
 */
function PullSecretsLookups({ workloads }: { workloads: UnscannedContainer[] }) {
    const distinct = [...new Set(workloads.map((w) => w.namespace))];
    const inline = distinct.slice(0, INLINE_LOOKUPS);
    const rest = distinct.slice(INLINE_LOOKUPS);
    const block = (namespace: string) => (
        <div key={namespace} className="space-y-1">
            <p className="text-[11px] font-mono text-ink-muted">{namespace}</p>
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
            <p className="text-[11px] text-ink-muted">
                No pods listed — a finished Job, say? The Secret usually comes from the namespace&apos;s ServiceAccount
                instead, which is also why it never shows on the Deployment or CronJob itself:
            </p>
            <CodeBlock code={serviceAccountLookup(distinct[0] ?? '<namespace>')} placeholders />
        </div>
    );
}

function RegistryAuthRemediation({
    hosts,
    workloads,
    open,
}: {
    hosts: string[];
    /** The auth-failed rows, worst-first, as the table renders them. */
    workloads: UnscannedContainer[];
    open?: boolean;
}) {
    const hostList = hosts.length > 0 ? hosts.join(', ') : 'a private registry';
    const exampleHost = hosts[0] ?? '<registry-host>';
    return (
        <details open={open} className="group border-b border-edge">
            <summary className="cursor-pointer list-none bg-danger-subtle px-5 py-3 [&::-webkit-details-marker]:hidden">
                <div className="flex items-start gap-2.5">
                    <KeyRound aria-hidden="true" className="mt-px size-4 shrink-0 text-danger" />
                    <div className="min-w-0 flex-1 text-xs text-danger">
                        <p className="font-medium">Registry authentication failed ({hostList})</p>
                        <p className="mt-1">
                            The scanner&apos;s pull was rejected, so these images will never get an SBOM until it has
                            credentials. Waiting will not fix this one.
                        </p>
                    </div>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs font-medium">
                    <span className="flex items-center gap-1 text-danger group-hover:underline">
                        <ChevronRight
                            aria-hidden="true"
                            className="size-3.5 transition-transform group-open:rotate-90"
                        />
                        How to fix
                    </span>
                    <a
                        href={PRIVATE_REGISTRY_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                        View docs
                        <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                </div>
            </summary>
            <div className="space-y-3 px-5 py-4">
                <RemediationOption
                    n={1}
                    title="Reuse your containers' pull Secrets"
                    whenTo="Use this when the affected pods already pull with imagePullSecrets."
                >
                    <RemediationStep n={1}>
                        Find the Secret names each affected container pulls with — different namespaces often use
                        different Secrets, so check each:
                    </RemediationStep>
                    <PullSecretsLookups workloads={workloads} />
                    <RemediationStep n={2}>
                        Let the scanner read exactly those Secrets — the chart turns the list into an RBAC{' '}
                        <code className="font-mono">resourceNames</code> restriction:
                    </RemediationStep>
                    <CodeBlock
                        code={`helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \\
  --namespace stackradar --reuse-values \\
  --set-string scanner.resolveImagePullSecrets=true \\
  --set 'scanner.imagePullSecretNames={<secret-name>}'`}
                        placeholders
                    />
                </RemediationOption>
                <OrDivider />
                <RemediationOption
                    n={2}
                    title="Give the scanner its own credential"
                    whenTo="Use this when your pods pull via node identity and carry no pull Secrets — or to keep the scanner's access separate."
                >
                    <RemediationStep n={1}>Create a registry Secret for the scanner:</RemediationStep>
                    <CodeBlock
                        code={`kubectl create secret docker-registry stackradar-registry \\
  --namespace stackradar \\
  --docker-server=${exampleHost} \\
  --docker-username=<username> --docker-password=<password>`}
                        placeholders
                    />
                    <RemediationStep n={2}>Point the chart at it:</RemediationStep>
                    <CodeBlock
                        code={`helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \\
  --namespace stackradar --reuse-values \\
  --set dockerConfigSecret=stackradar-registry`}
                    />
                </RemediationOption>
                <p className="text-xs text-ink-muted">
                    The error clears on its own once the next scan uploads. Details, including workload-identity setups:{' '}
                    <a
                        href={PRIVATE_REGISTRY_DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                    >
                        scanning private registries
                    </a>
                    .
                </p>
            </div>
        </details>
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

    /* Classified once, and the status travels with the row — the table renders
       worst-first, so asking "what is this one" again per row would be a
       second source of truth. */
    const rows = useMemo(() => {
        const classified = (coverage?.workloads ?? []).map((w) => ({
            workload: w,
            status: classifyRow(w),
        }));
        // Worst first; the server already ordered by oldest-discovered within
        // each group.
        return classified.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    }, [coverage]);

    const authFailedHosts = useMemo(
        () => [
            ...new Set(
                rows
                    .filter((r) => r.status === 'auth_failed')
                    .map((r) => r.workload.scanErrorHost)
                    .filter((h): h is string => Boolean(h)),
            ),
        ],
        [rows],
    );
    const authFailedContainers = useMemo(
        () => rows.filter((r) => r.status === 'auth_failed').map((r) => r.workload),
        [rows],
    );
    const authFailedCount = authFailedContainers.length;
    const stuckCount = rows.filter((r) => r.status === 'stuck' || r.status === 'scan_failed').length;
    const pendingCount = rows.filter((r) => r.status === 'waiting' || r.status === 'rate_limited').length;

    /* Polls only while something can genuinely resolve on its own — waiting
       scans, and rate-limited ones the scanner is retrying. Auth failures and
       stuck rows end with an operator action, not with time, and polling them
       would be asking a backend with nothing new to say, forever. */
    usePollWhile(pendingCount > 0, revalidate, POLL_MS);
    useRevalidateOnFocus(revalidate, { lastUpdated, staleAfterMs: STALE_AFTER_MS, enabled: !isLoading });

    /* Deep-linked from the Dashboard's registry-auth banner. The card mounts
       empty and fills in after its own fetch, so the browser's hash scroll on
       navigation finds nothing to scroll to; do it once the content exists,
       and open the remediation the reader was sent here for. */
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
            className={`scroll-mt-6 bg-surface-raised rounded-md border border-edge ${className}`}
        >
            <div className="px-5 py-4 border-b border-edge">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-sm font-semibold text-ink-secondary">Coverage</h2>
                        <p className="text-xs text-ink-muted mt-0.5">
                            Containers running in this cluster, against the ones StackRadar has an SBOM for
                        </p>
                    </div>
                    {gap === 0 && <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />}
                </div>
                <div className="mt-3">
                    <InventoryProgress discovered={coverage.discovered} scanned={coverage.scanned} />
                </div>
            </div>

            {gap === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-muted text-center">
                    Every container the scanner can see has an SBOM.
                </p>
            ) : (
                <>
                    {authFailedCount > 0 && (
                        <RegistryAuthRemediation
                            hosts={authFailedHosts}
                            workloads={authFailedContainers}
                            open={deepLinked}
                        />
                    )}
                    {stuckCount > 0 && (
                        <div className="flex items-start gap-2.5 px-5 py-3 border-b border-edge bg-attention-subtle">
                            <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-attention mt-px" />
                            <p className="text-xs text-attention">
                                {stuckCount === 1 ? 'One container is' : `${stuckCount} containers are`} failing to
                                scan, or waiting longer than an image pull and SBOM generation should take — often an
                                image pull backoff or a scan that ran out of memory. The scanner pod logs carry the full
                                error.
                            </p>
                        </div>
                    )}
                    <Table aria-label="Containers without an SBOM">
                        <TableHead>
                            {/* The image is the first thing to go on a phone:
                                the container cell already names the workload,
                                the namespace and the failure, which is what
                                the fix above is keyed on. */}
                            <TableHeader className="w-1/3">Container</TableHeader>
                            <TableHeader hideBelow="sm">Image</TableHeader>
                            <TableHeader align="end" className="w-20 sm:w-28">
                                Waiting
                            </TableHeader>
                        </TableHead>
                        <TableBody>
                            {rows.map(({ workload: w, status }) => {
                                const digest = formatShortDigest(w.imageDigest);
                                const isFailed =
                                    status === 'auth_failed' || status === 'scan_failed' || status === 'stuck';
                                return (
                                    <TableRow key={`${w.namespace}/${w.workloadName}/${w.containerName}`}>
                                        <TableCell className="max-w-0 w-1/3">
                                            <span className="block truncate font-medium text-ink">
                                                {w.workloadName}/{w.containerName}
                                            </span>
                                            <span className="flex items-center gap-2 min-w-0">
                                                <span className="truncate text-xs text-ink-muted">{w.namespace}</span>
                                                <RowStatusBadge status={status} host={w.scanErrorHost} />
                                            </span>
                                        </TableCell>
                                        <TableCell hideBelow="sm" className="text-xs font-mono text-ink-muted max-w-0">
                                            <span className="flex items-center gap-2 min-w-0" title={w.imageRef}>
                                                <span className="truncate">
                                                    {formatImageName(w.imageRef) ?? w.imageRef}
                                                </span>
                                                {digest && (
                                                    <span className="shrink-0 rounded-sm bg-surface-hover px-1.5 py-0.5 text-ink-secondary">
                                                        {digest}
                                                    </span>
                                                )}
                                            </span>
                                        </TableCell>
                                        <TableCell align="end" className="w-20 sm:w-28 tabular-nums">
                                            <span
                                                className={isFailed ? 'text-attention font-medium' : 'text-ink-muted'}
                                            >
                                                {waitedFor(w.firstSeenAt)}
                                            </span>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </>
            )}
        </div>
    );
}

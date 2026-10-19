import type { Capabilities } from '@/lib/edition';
import type { ClusterCoverage } from '@/types/cluster';
import { SCANNER_HELM_CHART } from './scannerInstall';

/**
 * The pure half of the Coverage card: what a row without an SBOM *is*, how
 * the rows fold, and the exact fix for a registry that rejects the scanner's
 * pull. Kept out of the component so every command the card renders is a
 * string a test can read, and so the chart-specific knowledge — which
 * release the scanner lives in, how its values nest — is in one place.
 */

export type UnscannedContainer = ClusterCoverage['workloads'][number];

/**
 * How long a workload may sit undiscovered-to-scanned before we stop calling it
 * "in progress".
 *
 * Image pull plus syft is minutes, not half an hour, even for a large image on
 * a slow link. Past this the honest reading is that something is wrong, and
 * saying "generating SBOMs" would be the product lying about its own coverage.
 * This heuristic is the *fallback*: when the scanner has reported a failure
 * reason, the reason wins — an auth failure surfaces immediately, because it
 * is known and there is nothing to wait out.
 */
export const STUCK_AFTER_MS = 30 * 60_000;

/**
 * What a row without an SBOM *is*, worst first. The scanner's reported reason
 * outranks the elapsed-time heuristic — a known failure needs no 30-minute
 * wait, and a known-transient one must never be called stuck.
 */
export type RowStatus = 'auth_failed' | 'scan_failed' | 'stuck' | 'waiting' | 'rate_limited';

export const STATUS_ORDER: Record<RowStatus, number> = {
    auth_failed: 0,
    scan_failed: 1,
    stuck: 2,
    waiting: 3,
    rate_limited: 4,
};

export function classifyRow(w: UnscannedContainer, now: number = Date.now()): RowStatus {
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
            return now - new Date(w.firstSeenAt).getTime() >= STUCK_AFTER_MS ? 'stuck' : 'waiting';
        default:
            /* `scan_error`, and any code a newer scanner invents: a failure
               with no specific remediation. The scanner pod's logs carry the
               detail the product deliberately does not transmit. */
            return 'scan_failed';
    }
}

export interface ClassifiedRow {
    workload: UnscannedContainer;
    status: RowStatus;
}

/**
 * One image, every place it is missing from. A CronJob that fired six times
 * since the scanner started is six Jobs on one digest, and the failure — and
 * the fix — is per image, so six rows saying the same thing bury the one
 * line that matters. Folded on the digest (the ref when there is none),
 * worst status first, oldest sighting as the group's age.
 */
export interface ImageGroup {
    key: string;
    status: RowStatus;
    imageRef: string;
    imageDigest: string | null;
    scanErrorHost: string | null;
    /** Distinct namespaces the image is missing from, in first-seen order. */
    namespaces: string[];
    /** Every container row behind the group, worst-first as the caller sorted them. */
    containers: UnscannedContainer[];
    /** The oldest `firstSeenAt` among the containers. */
    firstSeenAt: string;
}

export function groupByImage(rows: ClassifiedRow[]): ImageGroup[] {
    const groups = new Map<string, ImageGroup>();
    for (const { workload: w, status } of rows) {
        const key = `${status}\u0000${w.imageDigest ?? w.imageRef}`;
        const group = groups.get(key);
        if (!group) {
            groups.set(key, {
                key,
                status,
                imageRef: w.imageRef,
                imageDigest: w.imageDigest,
                scanErrorHost: w.scanErrorHost,
                namespaces: [w.namespace],
                containers: [w],
                firstSeenAt: w.firstSeenAt,
            });
            continue;
        }
        group.containers.push(w);
        if (!group.namespaces.includes(w.namespace)) group.namespaces.push(w.namespace);
        if (w.firstSeenAt < group.firstSeenAt) group.firstSeenAt = w.firstSeenAt;
    }
    return [...groups.values()].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

/**
 * What the inventory said about the pull Secrets behind a set of containers.
 *
 * Three answers, because the fix differs for each: `named` — let the scanner
 * read exactly these; `none` — the pods carry no Secret (node identity, or an
 * image that only *looks* private), so the scanner needs a credential of its
 * own; `unknown` — the scanner is older than the field, so the operator has
 * to look. A `null` on any row keeps the answer at `unknown` rather than
 * `none`: "we did not look" must never become "there is nothing".
 */
export type PullSecretKnowledge = { kind: 'named'; names: string[] } | { kind: 'none' } | { kind: 'unknown' };

export function pullSecretKnowledge(containers: UnscannedContainer[]): PullSecretKnowledge {
    const names = new Set<string>();
    let unreported = false;
    for (const c of containers) {
        if (c.imagePullSecrets === null) unreported = true;
        else for (const n of c.imagePullSecrets) names.add(n);
    }
    if (names.size > 0) return { kind: 'named', names: [...names].sort() };
    return unreported || containers.length === 0 ? { kind: 'unknown' } : { kind: 'none' };
}

/**
 * Which chart carries this cluster's scanner, because the fix is a Helm
 * value and the two charts nest it differently.
 *
 * The community edition is one cluster, scanned by the `stackradar` chart's
 * bundled scanner subchart (alias `scanner`, so its values sit under
 * `scanner.scanner.*`). Everything else is the standalone scanner chart,
 * whose version the cluster reports in its heartbeat — pinning it keeps a
 * configuration change from doubling as a chart upgrade.
 */
export type ScannerInstall = { kind: 'bundled' } | { kind: 'standalone'; chartVersion: string | null };

export function scannerInstallFor(edition: Capabilities, scannerVersion: string | null): ScannerInstall {
    return edition.multiCluster ? { kind: 'standalone', chartVersion: scannerVersion } : { kind: 'bundled' };
}

export const COMMUNITY_HELM_CHART = 'oci://ghcr.io/lockdep/helm-charts/stackradar';

/** The release and namespace the install docs use; an operator who chose others edits two words. */
const RELEASE: Record<ScannerInstall['kind'], { name: string; namespace: string }> = {
    bundled: { name: 'stackradar', namespace: 'stackradar' },
    standalone: { name: 'stackradar-scanner', namespace: 'stackradar' },
};

export const SECRET_NAME_PLACEHOLDER = '<secret-name>';
/** The Secret the "own credential" path creates, in the scanner's namespace. */
export const SCANNER_REGISTRY_SECRET = 'stackradar-registry';

/** Where a value lives in the chart that carries the scanner. */
function valuePrefix(install: ScannerInstall): string {
    return install.kind === 'bundled' ? 'scanner.' : '';
}

/**
 * `helm upgrade` for the release that carries the scanner, pinned to the
 * installed chart version. Without `--version` Helm pulls the newest chart,
 * and a credentials fix would silently become an upgrade of the whole
 * install — the bundled chart's version is not known here, so it is a
 * placeholder the operator reads off `helm list`.
 */
function helmUpgrade(install: ScannerInstall, sets: string[]): string {
    const { name, namespace } = RELEASE[install.kind];
    const chart = install.kind === 'bundled' ? COMMUNITY_HELM_CHART : SCANNER_HELM_CHART;
    const version = install.kind === 'bundled' ? '<chart-version>' : (install.chartVersion ?? '<chart-version>');
    return [
        `helm upgrade ${name} ${chart}`,
        `--namespace ${namespace} --version ${version} --reuse-values`,
        ...sets,
    ].join(' \\\n  ');
}

function yamlList(names: string[], indent: string): string {
    return names.map((n) => `${indent}- ${n}`).join('\n');
}

/**
 * The values that let the scanner read the named pull Secrets. The list
 * becomes an RBAC `resourceNames` restriction: nothing else in the cluster
 * becomes readable, which is why the chart insists on names.
 */
export function pullSecretValuesYaml(install: ScannerInstall, names: string[]): string {
    const list = names.length > 0 ? names : [SECRET_NAME_PLACEHOLDER];
    const inner = install.kind === 'bundled' ? '    ' : '  ';
    const body = [
        `${inner}resolveImagePullSecrets: true`,
        `${inner}imagePullSecretNames:`,
        yamlList(list, `${inner}  `),
    ].join('\n');
    return install.kind === 'bundled' ? `scanner:\n  scanner:\n${body}` : `scanner:\n${body}`;
}

export function pullSecretHelmCommand(install: ScannerInstall, names: string[]): string {
    const list = names.length > 0 ? names : [SECRET_NAME_PLACEHOLDER];
    const p = valuePrefix(install);
    return helmUpgrade(install, [
        `--set-string ${p}scanner.resolveImagePullSecrets=true`,
        `--set '${p}scanner.imagePullSecretNames={${list.join(',')}}'`,
    ]);
}

/** `kubectl create secret docker-registry` in the scanner's namespace, for the "own credential" path. */
export function createRegistrySecretCommand(install: ScannerInstall, host: string | null): string {
    const { namespace } = RELEASE[install.kind];
    return [
        `kubectl create secret docker-registry ${SCANNER_REGISTRY_SECRET}`,
        `--namespace ${namespace}`,
        `--docker-server=${host ?? '<registry-host>'}`,
        '--docker-username=<username> --docker-password=<password>',
    ].join(' \\\n  ');
}

export function dockerConfigValuesYaml(install: ScannerInstall): string {
    return install.kind === 'bundled'
        ? `scanner:\n  dockerConfigSecret: ${SCANNER_REGISTRY_SECRET}`
        : `dockerConfigSecret: ${SCANNER_REGISTRY_SECRET}`;
}

export function dockerConfigHelmCommand(install: ScannerInstall): string {
    return helmUpgrade(install, [`--set ${valuePrefix(install)}dockerConfigSecret=${SCANNER_REGISTRY_SECRET}`]);
}

/**
 * The `kubectl` that prints the pull Secret names of every pod in a
 * namespace, for a scanner too old to report them. Pods, not controllers:
 * the ServiceAccount admission plugin copies a ServiceAccount's
 * `imagePullSecrets` onto each pod at creation (DigitalOcean's registry
 * integration, for one, relies on this), so a Deployment or Job template
 * can be empty while its pods — and the scanner, which reads the pod — see
 * the Secret.
 */
export function pullSecretsLookup(namespace: string): string {
    return `kubectl get pods -n ${namespace} -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.imagePullSecrets[*].name}{"\\n"}{end}'`;
}

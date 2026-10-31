import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixtures, stack } from './stack';

/**
 * What the scanner does, with `fetch`: a heartbeat, a full-set inventory
 * report and an SBOM upload, against the server's public `/v1/*` API with
 * the cluster-scoped key. Both are the shapes in docs/contracts/ and the
 * curl in docs/self-hosting/docker-compose.md; nothing here goes through
 * the browser or the BFF.
 */

/** The image the tests know by name: the fixture SBOM, deployed as one container. */
export const nginx = {
    repository: 'nginx',
    registry: 'docker.io',
    tag: '1.27-alpine',
    imageRef: 'docker.io/nginx:1.27-alpine',
    namespace: 'e2e-web',
    workload: 'nginx',
    container: 'nginx',
} as const;

/**
 * A container whose image the scanner could not pull: a private registry
 * that refused the pull. No SBOM is ever uploaded for it, and the report
 * carries the `registry_auth` failure, so it is what the coverage card,
 * the "Not scanned" state and the auth banner are about.
 */
export const privateApi = {
    repository: 'acme/private-api',
    registry: 'registry.example.internal',
    tag: '2.4.1',
    imageRef: 'registry.example.internal/acme/private-api:2.4.1',
    namespace: 'e2e-private',
    workload: 'private-api',
    container: 'api',
    /** Any `sha256:` value: the scanner reads it off the node, here it is fixed so the seed is idempotent. */
    digest: `sha256:${createHash('sha256').update('stackradar-e2e-private-api-2.4.1').digest('hex')}`,
} as const;

/** The scanner version the seed reports; what the cluster list shows in its Version column. */
export const scannerVersion = '0.7.0';

function scannerHeaders(extra: Record<string, string> = {}, key: string = stack.scannerKey): Record<string, string> {
    return {
        'X-API-Key': key,
        'X-Scanner-Version': scannerVersion,
        ...extra,
    };
}

async function failOn(res: Response, what: string, allowed: number[] = []): Promise<Response> {
    if (res.ok || allowed.includes(res.status)) return res;
    const body = await res.text();
    throw new Error(`${what}: ${res.status} ${res.statusText}\n${body.slice(0, 2000)}`);
}

/** The digest the hand-upload docs use: the SBOM file's own SHA-256, which is as good as any `sha256:` value. */
export async function nginxDigest(): Promise<string> {
    const bytes = await readFile(fixtures.nginxSbom);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function heartbeat(): Promise<void> {
    const res = await fetch(`${stack.apiUrl}/v1/heartbeat`, {
        method: 'POST',
        headers: scannerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
    });
    await failOn(res, 'POST /v1/heartbeat');
}

export interface InventoryOptions {
    /** The nginx container's digest; omitted = the container is not in the report. */
    nginxDigest?: string;
    /** Include the private-registry container with its `registry_auth` failure. Default true. */
    privateApi?: boolean;
}

/**
 * The report a scanner would send for this stack: one Deployment per
 * namespace, every container running one pod. A full-set replacement, so
 * sending it twice is sending it once; leaving a container out removes it.
 */
export function inventoryReport({ nginxDigest, privateApi: withPrivate = true }: InventoryOptions): object {
    const namespaces: object[] = [];
    if (nginxDigest) {
        namespaces.push({
            name: nginx.namespace,
            labels: { 'e2e.stackradar.io/suite': 'playwright' },
            workloads: [
                {
                    kind: 'Deployment',
                    name: nginx.workload,
                    release: null,
                    application: null,
                    runningPods: 1,
                    firstStartedAt: '2026-01-01T00:00:00.000Z',
                    labels: { app: nginx.workload },
                    containers: [
                        {
                            name: nginx.container,
                            init: false,
                            imageRef: nginx.imageRef,
                            imageDigest: nginxDigest,
                            imageTag: nginx.tag,
                            registry: nginx.registry,
                            repository: nginx.repository,
                            runningPods: 1,
                        },
                    ],
                },
            ],
        });
    }
    if (withPrivate) {
        namespaces.push({
            name: privateApi.namespace,
            labels: { 'e2e.stackradar.io/suite': 'playwright' },
            workloads: [
                {
                    kind: 'Deployment',
                    name: privateApi.workload,
                    release: null,
                    application: null,
                    runningPods: 1,
                    firstStartedAt: '2026-01-01T00:00:00.000Z',
                    labels: { app: privateApi.workload },
                    containers: [
                        {
                            name: privateApi.container,
                            init: false,
                            imageRef: privateApi.imageRef,
                            imageDigest: privateApi.digest,
                            imageTag: privateApi.tag,
                            registry: privateApi.registry,
                            repository: privateApi.repository,
                            runningPods: 1,
                            imagePullSecrets: ['acme-registry'],
                        },
                    ],
                },
            ],
        });
    }
    return {
        version: 3,
        reportedAt: new Date().toISOString(),
        informerSynced: true,
        ownerMetadataCollected: true,
        releases: [],
        applications: [],
        scanFailures: withPrivate
            ? [{ imageDigest: privateApi.digest, code: 'registry_auth', registryHost: privateApi.registry }]
            : [],
        namespaces,
    };
}

/**
 * The endpoint allows a burst of five reports per key and refills two a
 * minute (a scanner reports every few minutes); a suite run back to back
 * with the last one can hit the limit, so a 429 is waited out, not failed.
 */
export async function reportInventory(options: InventoryOptions): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${stack.apiUrl}/v1/inventory`, {
            method: 'POST',
            headers: scannerHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(inventoryReport(options)),
        });
        if (res.status === 429 && attempt < 4) {
            const retryAfter = Number(res.headers.get('retry-after')) || 35;
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            continue;
        }
        await failOn(res, 'POST /v1/inventory');
        return;
    }
}

export interface UploadResult {
    /** False when the cluster already had this digest's SBOM (409) and the earlier upload stands. */
    created: boolean;
    imageId?: string;
    componentCount?: number;
}

/** Upload the fixture SBOM for the digest. A second run answers 409, which is the stack remembering the first. */
export async function uploadNginxSbom(imageDigest: string): Promise<UploadResult> {
    const body = await readFile(fixtures.nginxSbom);
    const url = new URL('/v1/sboms/upload/cyclonedx', stack.apiUrl);
    url.searchParams.set('imageDigest', imageDigest);
    url.searchParams.set('imageRef', nginx.imageRef);
    const res = await failOn(
        await fetch(url, {
            method: 'POST',
            headers: scannerHeaders({ 'Content-Type': 'application/json' }),
            body,
        }),
        'POST /v1/sboms/upload/cyclonedx',
        [409],
    );
    if (res.status === 409) return { created: false };
    const created = (await res.json()) as { imageId: string; componentCount: number };
    return { created: true, imageId: created.imageId, componentCount: created.componentCount };
}

/** For the API spec: the same headers the seed uses, with a key of the caller's choosing. */
export { scannerHeaders };

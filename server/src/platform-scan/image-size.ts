/**
 * How big an image is before syft pulls it: the compressed layer sizes the
 * manifest declares, summed. syft runs inside the worker's own cgroup, and
 * its working set grows with the image it catalogues — a 200 MiB
 * (compressed) Argo CD image took the worker past its 512Mi limit in 14 s
 * on 2026-09-10, and the kill stranded the rest of that night's batch.
 * Reading the manifest costs one or two small GETs and no disk, so the scan
 * job asks here first and refuses an image over `PLATFORM_SCAN_MAX_IMAGE_BYTES`
 * with a reason, never pulling it. (The charts index scanner does the same
 * for its 8 GiB emptyDir; this is the server-side twin.)
 *
 * The digest on the job is what the kubelet would pull: usually an index
 * (manifest list), sometimes a single manifest. For an index the child for
 * the configured platform is fetched by digest through the same session
 * (one Bearer token); attestation entries (`unknown/unknown`) are not
 * platforms. Anything the walk cannot read — a schema-1 manifest without
 * layer sizes, no child for the platform, a non-2xx status, a network error
 * — is "unmeasured", and the caller pulls anyway: syft's own error is the
 * authoritative one, and a registry quirk must not fail an image syft would
 * handle.
 *
 * On Docker Hub a GET on a manifest URL counts against the pull limit, so
 * this is one extra "pull" per image there; a 429 is reported as
 * `rateLimited`, the same signal syft would give.
 */

import { manifestRequest, openSession, type RegistryOptions, type RegistrySession } from "../chart-render/registry.js";

export type ImageSizeResult =
    | { ok: true; bytes: number; layers: number }
    /** `rateLimited`: the registry answered 429 — nothing is known about the image. */
    | { ok: false; reason: string; rateLimited: boolean };

export type ImageRef = { registry: string; repository: string; digest: string };

interface Descriptor {
    digest?: unknown;
    size?: unknown;
    platform?: { os?: unknown; architecture?: unknown; variant?: unknown };
}

interface Manifest {
    mediaType?: unknown;
    manifests?: unknown;
    layers?: unknown;
    config?: unknown;
}

/** `os/arch[/variant]` as `PLATFORM_SCAN_PLATFORM` spells it. */
function parsePlatform(platform: string): { os: string; architecture: string; variant: string | null } | null {
    const [os, architecture, variant] = platform.split("/");
    if (!os || !architecture) return null;
    return { os, architecture, variant: variant ?? null };
}

function pickChild(manifests: unknown, platform: string): Descriptor | null {
    const want = parsePlatform(platform);
    if (!want || !Array.isArray(manifests)) return null;
    const candidates = (manifests as Descriptor[]).filter(
        (m) =>
            m.platform?.os === want.os &&
            m.platform?.architecture === want.architecture &&
            typeof m.digest === "string"
    );
    // A variant in the platform must match; without one, the entry without a variant wins, else the first.
    if (want.variant) return candidates.find((m) => m.platform?.variant === want.variant) ?? null;
    return candidates.find((m) => !m.platform?.variant) ?? candidates[0] ?? null;
}

function sumLayers(manifest: Manifest): { bytes: number; layers: number } | null {
    if (!Array.isArray(manifest.layers)) return null;
    let bytes = 0;
    for (const layer of manifest.layers as Descriptor[]) {
        if (typeof layer.size !== "number" || !Number.isFinite(layer.size) || layer.size < 0) return null;
        bytes += layer.size;
    }
    const config = (manifest.config as Descriptor | undefined)?.size;
    if (typeof config === "number" && Number.isFinite(config) && config > 0) bytes += config;
    return { bytes, layers: manifest.layers.length };
}

async function fetchManifest(
    session: RegistrySession,
    reference: string
): Promise<{ ok: true; manifest: Manifest } | { ok: false; reason: string; rateLimited: boolean }> {
    const result = await manifestRequest(session, reference);
    if (!result.ok) return { ok: false, reason: result.reason, rateLimited: false };
    const { response } = result;
    if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return { ok: false, reason: `HTTP ${response.status} fetching manifest`, rateLimited: response.status === 429 };
    }
    try {
        return { ok: true, manifest: (await response.json()) as Manifest };
    } catch (err) {
        return {
            ok: false,
            reason: `manifest is not JSON: ${err instanceof Error ? err.message : String(err)}`,
            rateLimited: false,
        };
    }
}

export async function imageLayerBytes(
    image: ImageRef,
    platform: string,
    opts: RegistryOptions
): Promise<ImageSizeResult> {
    const session = openSession(image, opts);
    const top = await fetchManifest(session, image.digest);
    if (!top.ok) return top;

    let manifest = top.manifest;
    if (Array.isArray(manifest.manifests)) {
        const child = pickChild(manifest.manifests, platform);
        if (!child) return { ok: false, reason: `no ${platform} manifest in the index`, rateLimited: false };
        const leaf = await fetchManifest(session, child.digest as string);
        if (!leaf.ok) return leaf;
        manifest = leaf.manifest;
    }
    const total = sumLayers(manifest);
    if (!total) return { ok: false, reason: "manifest declares no layer sizes", rateLimited: false };
    return { ok: true, ...total };
}

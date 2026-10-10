/**
 * Feeds `lib/base-image.ts`, stores its verdict on `images`, and cuts
 * `components.from_base` at the boundary.
 *
 * Three callers:
 *
 *   - the SBOM ingest, right after the image's layers are written — the
 *     signals that need only the database (a named base with a known chain,
 *     a known public prefix, a golden base inside the org, buildpacks,
 *     history);
 *   - the nightly pass ({@link reresolveBases}), for images whose boundary is
 *     still unknown: the known-prefix table grows, and a base the image
 *     *names* can be counted — and one it does not name can be guessed from
 *     its `_VERSION` env and **verified** — by asking the public registry;
 *   - `POST /internal/known-images`, through {@link recordKnownChains}.
 *
 * What a registry answer is allowed to do: a chain is only ever recorded as
 * known when its diff ids were fetched by us from a public registry, and a
 * guessed name is only ever stored when that chain is a strict prefix of the
 * image's own. Nothing here is a guess by the time it reaches a column.
 */

import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import { blobRequest, manifestRequest, openSession, type RegistryOptions } from "../chart-render/registry.js";
import {
    chainHash,
    chainOf,
    prefixHashes,
    resolveBase,
    type BaseLayer,
    type BaseVerdict,
    type KnownChain,
    type OrgSibling,
} from "../lib/base-image.js";
import { layerAttributionTrusted } from "../lib/image-layers.js";
import { isPublicRegistry } from "../lib/public-registries.js";
import { parseImageRef } from "../utils/image-ref.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("base-image");

type Executor = typeof db | Transaction;

/** An org's other images are compared at most this many at a time — newest first. */
const MAX_SIBLINGS = 500;

export interface KnownImageInput {
    imageRef: string;
    diffIds: string[];
}

/** Record whole chains of public images. Idempotent; a chain of one layer says too little to be a base. */
export async function recordKnownChains(
    images: readonly KnownImageInput[],
    source: "chart-index" | "registry" | "verified-guess",
    executor: Executor = db
): Promise<number> {
    const rows = images
        .filter((i) => i.imageRef.trim() !== "" && i.diffIds.length > 0 && i.diffIds.length <= 127)
        .filter((i) => i.diffIds.every((d) => /^sha256:[0-9a-f]{64}$/.test(d)))
        .map((i) => ({
            diffIdPrefixHash: chainHash(i.diffIds),
            depth: i.diffIds.length,
            imageRef: i.imageRef.trim().slice(0, 1024),
            source,
        }));
    if (rows.length === 0) return 0;

    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
        const inserted = await executor
            .insert(schema.knownLayerPrefixes)
            .values(rows.slice(i, i + 500))
            .onConflictDoNothing()
            .returning({ hash: schema.knownLayerPrefixes.diffIdPrefixHash });
        written += inserted.length;
    }
    return written;
}

async function knownChainsFor(chain: readonly string[], executor: Executor): Promise<KnownChain[]> {
    if (chain.length === 0) return [];
    const hashes = prefixHashes(chain);
    const rows = await executor
        .select({
            hash: schema.knownLayerPrefixes.diffIdPrefixHash,
            depth: schema.knownLayerPrefixes.depth,
            imageRef: schema.knownLayerPrefixes.imageRef,
        })
        .from(schema.knownLayerPrefixes)
        .where(inArray(schema.knownLayerPrefixes.diffIdPrefixHash, hashes));
    // The hash of the first k layers must be stored at depth k — otherwise it
    // is a collision between chains of different lengths, however unlikely.
    return rows.filter((r) => hashes[r.depth - 1] === r.hash).map((r) => ({ depth: r.depth, imageRef: r.imageRef }));
}

async function siblingsOf(orgId: string, imageId: string, executor: Executor): Promise<OrgSibling[]> {
    const rows = await executor
        .select({
            imageId: schema.imageLayers.imageId,
            registry: schema.images.registry,
            repository: schema.images.repository,
            diffIds: sql<string[]>`array_agg(${schema.imageLayers.diffId} ORDER BY ${schema.imageLayers.rootfsIndex})`,
        })
        .from(schema.imageLayers)
        .innerJoin(schema.images, eq(schema.images.id, schema.imageLayers.imageId))
        .where(and(eq(schema.images.orgId, orgId), ne(schema.images.id, imageId), isNotNull(schema.imageLayers.diffId)))
        .groupBy(schema.imageLayers.imageId, schema.images.registry, schema.images.repository, schema.images.lastSeenAt)
        .orderBy(sql`${schema.images.lastSeenAt} DESC`)
        .limit(MAX_SIBLINGS);
    return rows.map((r) => ({
        imageRef: r.repository ? [r.registry, r.repository].filter(Boolean).join("/") : null,
        diffIds: r.diffIds,
    }));
}

function asBaseLayers(rows: readonly { rootfsIndex: number | null; diffId: string | null; createdBy: string | null; builtAt: Date | null; index: number }[]): BaseLayer[] {
    return [...rows]
        .sort((a, b) => a.index - b.index)
        .map((l) => ({ rootfsIndex: l.rootfsIndex, diffId: l.diffId, createdBy: l.createdBy, builtAt: l.builtAt }));
}

/**
 * Resolve one image's base from what the database holds, store it, and set
 * `from_base` on the components of its SBOM. Safe to call again: it writes
 * the verdict it reaches, including "none".
 */
export async function resolveBaseForImage(imageId: string, executor: Executor = db): Promise<BaseVerdict | null> {
    const [image] = await executor
        .select({ id: schema.images.id, orgId: schema.images.orgId, metadata: schema.images.metadata })
        .from(schema.images)
        .where(eq(schema.images.id, imageId));
    if (!image) return null;

    const layerRows = await executor.select().from(schema.imageLayers).where(eq(schema.imageLayers.imageId, imageId));
    if (layerRows.length === 0) return null;

    const layers = asBaseLayers(layerRows);
    const chain = chainOf(layers);
    const [knownChains, siblings] = await Promise.all([
        knownChainsFor(chain, executor),
        siblingsOf(image.orgId, imageId, executor),
    ]);

    const verdict = resolveBase({ layers, facts: image.metadata, knownChains, siblings });
    await storeVerdict(imageId, verdict, executor);
    return verdict;
}

async function storeVerdict(imageId: string, verdict: BaseVerdict | null, executor: Executor): Promise<void> {
    await executor
        .update(schema.images)
        .set({
            baseImageRef: verdict?.baseImageRef ?? null,
            baseLayerCount: verdict?.baseLayerCount ?? null,
            baseDetectedBy: verdict?.detectedBy ?? null,
        })
        .where(eq(schema.images.id, imageId));

    const [sbom] = await executor
        .select({ id: schema.sboms.id, scannerVersion: schema.sboms.scannerVersion })
        .from(schema.sboms)
        .where(eq(schema.sboms.imageId, imageId));
    if (!sbom) return;

    const count = verdict?.baseLayerCount ?? null;
    const trusted = layerAttributionTrusted(sbom.scannerVersion);
    // The SQL twin of `fromBase` in `lib/base-image.ts`.
    await executor.execute(sql`
        UPDATE components
           SET from_base = CASE
                   WHEN ${count}::int IS NULL OR layer_index IS NULL THEN NULL
                   WHEN tier = 'os' AND NOT ${trusted}::boolean THEN NULL
                   ELSE layer_index < ${count}::int
               END
         WHERE sbom_id = ${sbom.id}
    `);
}

// ─── The nightly pass ─────────────────────────────────────────────────────

export interface BaseReresolveStats {
    examined: number;
    resolved: number;
    registryLookups: number;
    rateLimited: boolean;
}

interface ConfigBlob {
    rootfs?: { diff_ids?: unknown };
}

type Fetched = { ok: true; diffIds: string[] } | { ok: false; rateLimited: boolean };

/** The diff ids of a public image, by ref — linux/amd64 first, then linux/arm64. */
async function fetchChain(ref: string, opts: RegistryOptions): Promise<Fetched> {
    const parsed = parseImageRef(ref);
    const registry = parsed.registry ?? "docker.io";
    const repository = parsed.repository;
    if (!repository || !isPublicRegistry(registry)) return { ok: false, rateLimited: false };
    const reference = parsed.digest ?? parsed.tag ?? "latest";

    const session = openSession({ registry, repository: registry === "docker.io" && !repository.includes("/") ? `library/${repository}` : repository }, opts);
    const read = async <T>(result: Awaited<ReturnType<typeof manifestRequest>>): Promise<T | "limited" | null> => {
        if (!result.ok) return null;
        if (!result.response.ok) {
            await result.response.arrayBuffer().catch(() => undefined);
            return result.response.status === 429 ? "limited" : null;
        }
        return (await result.response.json().catch(() => null)) as T | null;
    };

    type Manifest = { config?: { digest?: unknown }; manifests?: { digest?: unknown; platform?: { os?: unknown; architecture?: unknown } }[] };
    let manifest = await read<Manifest>(await manifestRequest(session, reference));
    if (manifest === "limited") return { ok: false, rateLimited: true };
    if (!manifest) return { ok: false, rateLimited: false };

    if (Array.isArray(manifest.manifests)) {
        const pick = (arch: string) => manifest !== "limited" && manifest?.manifests?.find((m) => m.platform?.os === "linux" && m.platform.architecture === arch);
        const child = pick("amd64") || pick("arm64");
        if (!child || typeof child.digest !== "string") return { ok: false, rateLimited: false };
        manifest = await read<Manifest>(await manifestRequest(session, child.digest));
        if (manifest === "limited") return { ok: false, rateLimited: true };
        if (!manifest) return { ok: false, rateLimited: false };
    }

    const configDigest = manifest.config?.digest;
    if (typeof configDigest !== "string") return { ok: false, rateLimited: false };
    const config = await read<ConfigBlob>(await blobRequest(session, configDigest));
    if (config === "limited") return { ok: false, rateLimited: true };
    const diffIds = Array.isArray(config?.rootfs?.diff_ids)
        ? (config!.rootfs!.diff_ids as unknown[]).filter((d): d is string => typeof d === "string")
        : [];
    return diffIds.length > 0 ? { ok: true, diffIds } : { ok: false, rateLimited: false };
}

/** Runtime images whose tag follows their `_VERSION` env, and how a distro spells the variant. */
const RUNTIME_IMAGES: Readonly<Record<string, string>> = {
    NODE_VERSION: "node",
    PYTHON_VERSION: "python",
    GOLANG_VERSION: "golang",
    RUBY_VERSION: "ruby",
    PHP_VERSION: "php",
    NGINX_VERSION: "nginx",
};

const DEBIAN_CODENAMES: Readonly<Record<string, string>> = { "13": "trixie", "12": "bookworm", "11": "bullseye", "10": "buster" };

/**
 * Official-image tags an image's `_VERSION` env and distro suggest — to be
 * **verified**, never believed: `node` + `20.11.1` on Debian 12 proposes
 * `node:20.11.1-bookworm-slim`, `node:20.11.1-bookworm`, `node:20.11.1-slim`.
 */
export function guessBaseRefs(facts: Readonly<Record<string, string>> | null, distro: { id: string; version: string } | null): string[] {
    if (!facts) return [];
    const guesses: string[] = [];
    for (const [key, image] of Object.entries(RUNTIME_IMAGES)) {
        const version = facts[`env:${key}`]?.trim();
        if (!version || !/^[0-9][0-9A-Za-z.+_-]*$/.test(version)) continue;
        if (distro?.id === "debian") {
            const codename = DEBIAN_CODENAMES[distro.version.split(".")[0] ?? ""];
            if (codename) guesses.push(`${image}:${version}-${codename}-slim`, `${image}:${version}-slim-${codename}`, `${image}:${version}-${codename}`);
            guesses.push(`${image}:${version}-slim`, `${image}:${version}`);
        } else if (distro?.id === "alpine") {
            const minor = distro.version.split(".").slice(0, 2).join(".");
            guesses.push(`${image}:${version}-alpine${minor}`, `${image}:${version}-alpine`);
        }
    }
    return guesses;
}

async function distroOf(imageId: string): Promise<{ id: string; version: string } | null> {
    const rows = await db.execute<{ name: string; version: string | null }>(sql`
        SELECT c.name, c.version
          FROM components c
          JOIN sboms s ON s.id = c.sbom_id
         WHERE s.image_id = ${imageId} AND c.type = 'operating-system'
         LIMIT 1
    `);
    const row = rows[0];
    return row?.version ? { id: row.name.toLowerCase(), version: row.version } : null;
}

/**
 * Re-resolve images whose boundary is unknown. Database signals first — the
 * known-prefix table grows every night — then, within `registryBudget`
 * lookups, the registry: count the base an image *names*, or verify one its
 * `_VERSION` env suggests. A 429 ends the registry work for the run.
 */
export async function reresolveBases(limit: number, registryBudget: number, opts: RegistryOptions): Promise<BaseReresolveStats> {
    const stats: BaseReresolveStats = { examined: 0, resolved: 0, registryLookups: 0, rateLimited: false };

    const candidates = await db
        .selectDistinct({ id: schema.images.id, metadata: schema.images.metadata, lastSeenAt: schema.images.lastSeenAt })
        .from(schema.images)
        .innerJoin(schema.imageLayers, eq(schema.imageLayers.imageId, schema.images.id))
        .where(isNull(schema.images.baseLayerCount))
        .orderBy(sql`${schema.images.lastSeenAt} DESC`)
        .limit(limit);

    for (const image of candidates) {
        stats.examined += 1;
        let verdict = await resolveBaseForImage(image.id);
        if (verdict?.baseLayerCount != null) {
            stats.resolved += 1;
            continue;
        }
        if (stats.rateLimited || stats.registryLookups >= registryBudget) continue;

        const layerRows = await db.select().from(schema.imageLayers).where(eq(schema.imageLayers.imageId, image.id));
        const chain = chainOf(asBaseLayers(layerRows));
        const named = image.metadata?.baseName?.trim();
        const refs = named ? [named] : guessBaseRefs(image.metadata, await distroOf(image.id));

        for (const ref of refs) {
            if (stats.registryLookups >= registryBudget) break;
            stats.registryLookups += 1;
            const fetched = await fetchChain(ref, opts);
            if (!fetched.ok) {
                if (fetched.rateLimited) {
                    stats.rateLimited = true;
                    log.warn({ ref }, "Registry rate limit reached; ending base lookups for this run");
                    break;
                }
                continue;
            }
            const isPrefix = fetched.diffIds.length < chain.length && fetched.diffIds.every((d, i) => chain[i] === d);
            // A named base whose chain is not our prefix is a moved tag: the
            // name stays on the image, the count stays unknown.
            if (!isPrefix) continue;
            await recordKnownChains([{ imageRef: ref, diffIds: fetched.diffIds }], named ? "registry" : "verified-guess");
            verdict = await resolveBaseForImage(image.id);
            break;
        }
        if (verdict?.baseLayerCount != null) stats.resolved += 1;
    }

    return stats;
}

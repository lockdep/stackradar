/**
 * Layer lists for images scanned before the scanner sent them (component
 * tier plan, item 5).
 *
 * A scanner ≥ 0.4.0 ships the ordered layers on the upload. Every SBOM
 * ingested before that already stores the *layer id* of every component
 * (`syft:location:N:layerID` in `component_properties`) — what is missing is
 * the order, which is in the image's config blob. For an image on a public
 * registry that is one manifest GET and one blob GET, anonymously, through
 * the client the platform scan already uses. Private images are not
 * reachable from here and fill on their next scan.
 *
 * What this can and cannot repair: `layer_index` becomes right for deb and
 * for every non-OS package, whose other locations kept their real layer. apk
 * and rpm packages from a squashed-scope SBOM have one location — the package
 * database — so their index is the last package-manager layer until the image
 * is rescanned; item 6 refuses to read it (`DEEP_SQUASHED_SCANNER_VERSION`).
 *
 * A multi-arch digest names an index, and which child the customer's node
 * pulled is not recorded anywhere — except in the SBOM: the child whose
 * `rootfs.diff_ids` contain the component layer ids is the one that was
 * scanned. Children are tried linux/amd64 first, then linux/arm64, then the
 * rest, and at most {@link MAX_CHILDREN_TRIED}, because every try is a
 * manifest GET that Docker Hub counts.
 *
 * A 429 ends the run: nothing is known about the image, and the next image
 * on the same registry would be told the same.
 */

import { and, eq, isNotNull, notExists, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
    blobRequest,
    manifestRequest,
    openSession,
    type RegistryOptions,
    type RegistrySession,
} from "../chart-render/registry.js";
import { isPublicRegistry } from "../lib/public-registries.js";
import { imageLayerRepository } from "../repositories/image-layer.repository.js";
import type { ParsedLayer } from "../lib/image-layers.js";
import { createLogger } from "../lib/logger.js";
import { resolveBaseForImage } from "./base-image.service.js";

const log = createLogger("image-layer-backfill");

const MAX_CHILDREN_TRIED = 3;
/** The scanner's cap, applied to lines the server fetches itself. */
const CREATED_BY_MAX_LENGTH = 200;

export interface LayerBackfillStats {
    candidates: number;
    filled: number;
    unreachable: number;
    /** No child of the index contains the SBOM's layer ids — scanned on another platform than any we tried. */
    unmatched: number;
    rateLimited: boolean;
}

interface Descriptor {
    digest?: unknown;
    platform?: { os?: unknown; architecture?: unknown };
}

interface ImageConfigBlob {
    history?: { created?: string; created_by?: string; empty_layer?: boolean }[];
    rootfs?: { diff_ids?: unknown };
}

type Fetched<T> = { ok: true; value: T } | { ok: false; rateLimited: boolean; reason: string };

async function readJson<T>(result: Awaited<ReturnType<typeof manifestRequest>>, what: string): Promise<Fetched<T>> {
    if (!result.ok) return { ok: false, rateLimited: false, reason: result.reason };
    const { response } = result;
    if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return { ok: false, rateLimited: response.status === 429, reason: `HTTP ${response.status} fetching ${what}` };
    }
    try {
        return { ok: true, value: (await response.json()) as T };
    } catch {
        return { ok: false, rateLimited: false, reason: `${what} is not JSON` };
    }
}

async function configOf(session: RegistrySession, manifestDigest: string): Promise<Fetched<ImageConfigBlob>> {
    const manifest = await readJson<{ config?: Descriptor; manifests?: Descriptor[] }>(
        await manifestRequest(session, manifestDigest),
        "manifest",
    );
    if (!manifest.ok) return manifest;
    const configDigest = manifest.value.config?.digest;
    if (typeof configDigest !== "string") return { ok: false, rateLimited: false, reason: "manifest names no config" };
    return readJson<ImageConfigBlob>(await blobRequest(session, configDigest), "config blob");
}

/** Pure: the ordered layers of a config blob, or null when its history does not account for its layers. */
export function layersFromConfig(config: ImageConfigBlob): ParsedLayer[] | null {
    const diffIds = Array.isArray(config.rootfs?.diff_ids)
        ? (config.rootfs!.diff_ids as unknown[]).filter((d): d is string => typeof d === "string")
        : [];
    if (diffIds.length === 0) return null;

    const history = config.history ?? [];
    const producing = history.filter((h) => h.empty_layer !== true).length;
    if (history.length === 0 || producing !== diffIds.length) {
        return diffIds.map((diffId, i) => ({
            index: i,
            rootfsIndex: i,
            diffId,
            createdBy: null,
            emptyLayer: false,
            size: null,
            created: null,
        }));
    }

    let next = 0;
    return history.map((h, index) => {
        const empty = h.empty_layer === true;
        const created = h.created ? new Date(h.created) : null;
        return {
            index,
            rootfsIndex: empty ? null : next,
            diffId: empty ? null : diffIds[next++]!,
            createdBy: h.created_by ? h.created_by.slice(0, CREATED_BY_MAX_LENGTH) : null,
            emptyLayer: empty,
            size: null,
            created: created && !Number.isNaN(created.getTime()) ? created : null,
        };
    });
}

/** Order the children of an index: linux/amd64, linux/arm64, then the rest. */
function orderChildren(manifests: Descriptor[]): string[] {
    const rank = (m: Descriptor) =>
        m.platform?.os !== "linux"
            ? 3
            : m.platform.architecture === "amd64"
              ? 0
              : m.platform.architecture === "arm64"
                ? 1
                : 2;
    return manifests
        .filter((m) => typeof m.digest === "string" && m.platform?.os !== "unknown")
        .sort((a, b) => rank(a) - rank(b))
        .map((m) => m.digest as string);
}

export async function resolveLayers(
    image: { registry: string; repository: string; digest: string },
    sbomLayerIds: ReadonlySet<string>,
    opts: RegistryOptions,
): Promise<Fetched<ParsedLayer[] | null>> {
    const session = openSession(image, opts);
    const top = await readJson<{ config?: Descriptor; manifests?: Descriptor[] }>(
        await manifestRequest(session, image.digest),
        "manifest",
    );
    if (!top.ok) return top;

    const matches = (layers: ParsedLayer[] | null): layers is ParsedLayer[] => {
        if (!layers) return false;
        const ids = new Set(layers.map((l) => l.diffId));
        // An SBOM with no layer ids at all (a hand-written one) matches nothing on purpose.
        return sbomLayerIds.size > 0 && [...sbomLayerIds].every((id) => ids.has(id));
    };

    if (!Array.isArray(top.value.manifests)) {
        const configDigest = top.value.config?.digest;
        if (typeof configDigest !== "string")
            return { ok: false, rateLimited: false, reason: "manifest names no config" };
        const config = await readJson<ImageConfigBlob>(await blobRequest(session, configDigest), "config blob");
        if (!config.ok) return config;
        const layers = layersFromConfig(config.value);
        return { ok: true, value: matches(layers) ? layers : null };
    }

    for (const child of orderChildren(top.value.manifests).slice(0, MAX_CHILDREN_TRIED)) {
        const config = await configOf(session, child);
        if (!config.ok) {
            if (config.rateLimited) return config;
            continue;
        }
        const layers = layersFromConfig(config.value);
        if (matches(layers)) return { ok: true, value: layers };
    }
    return { ok: true, value: null };
}

/**
 * `components.layer_index` for one SBOM from its stored layer ids — the SQL
 * twin of `resolveLayerIndex`: the minimum over every location.
 */
export async function resolveStoredLayerIndexes(imageId: string, sbomId: string): Promise<number> {
    const result = await db.execute(sql`
        UPDATE components AS c
           SET layer_index = resolved.layer_index
          FROM (
                SELECT p.component_id, min(l.rootfs_index) AS layer_index
                  FROM component_properties p
                  JOIN components owner ON owner.id = p.component_id
                  JOIN image_layers l ON l.image_id = ${imageId} AND l.diff_id = p.value
                 WHERE owner.sbom_id = ${sbomId}
                   AND p.name ~ '^syft:location:[0-9]+:layerID$'
                 GROUP BY p.component_id
               ) resolved
         WHERE c.id = resolved.component_id
    `);
    return result.count;
}

export async function backfillImageLayers(limit: number, opts: RegistryOptions): Promise<LayerBackfillStats> {
    const stats: LayerBackfillStats = { candidates: 0, filled: 0, unreachable: 0, unmatched: 0, rateLimited: false };

    const candidates = await db
        .select({
            imageId: schema.images.id,
            registry: schema.images.registry,
            repository: schema.images.repository,
            digest: schema.images.digest,
            sbomId: schema.sboms.id,
        })
        .from(schema.images)
        .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
        .where(
            and(
                isNotNull(schema.images.registry),
                isNotNull(schema.images.repository),
                notExists(
                    db
                        .select({ one: sql`1` })
                        .from(schema.imageLayers)
                        .where(eq(schema.imageLayers.imageId, schema.images.id)),
                ),
                sql`(${schema.images.layersCheckedAt} IS NULL OR ${schema.images.layersCheckedAt} < now() - interval '30 days')`,
            ),
        )
        // Newest first: the images people are looking at now.
        .orderBy(sql`${schema.images.lastSeenAt} DESC`)
        .limit(limit * 4);

    for (const image of candidates) {
        if (stats.filled + stats.unreachable + stats.unmatched >= limit) break;
        if (!isPublicRegistry(image.registry)) continue;
        stats.candidates += 1;

        const idRows = await db.execute<{ value: string }>(sql`
            SELECT DISTINCT p.value
              FROM component_properties p
              JOIN components c ON c.id = p.component_id
             WHERE c.sbom_id = ${image.sbomId}
               AND p.name ~ '^syft:location:[0-9]+:layerID$'
        `);
        const layerIds = new Set(idRows.map((r) => r.value));

        const resolved = await resolveLayers(
            { registry: image.registry!, repository: image.repository!, digest: image.digest },
            layerIds,
            opts,
        );
        if (!resolved.ok && resolved.rateLimited) {
            stats.rateLimited = true;
            log.warn({ registry: image.registry }, "Registry rate limit reached; ending the layer backfill run");
            break;
        }
        await db.update(schema.images).set({ layersCheckedAt: new Date() }).where(eq(schema.images.id, image.imageId));
        if (!resolved.ok) {
            stats.unreachable += 1;
            log.debug({ imageId: image.imageId, reason: resolved.reason }, "Could not read the image config");
            continue;
        }
        if (!resolved.value) {
            stats.unmatched += 1;
            continue;
        }

        await imageLayerRepository.replaceForImage(image.imageId, resolved.value, "registry");
        await resolveStoredLayerIndexes(image.imageId, image.sbomId);
        // The layers just arrived, so the boundary can be looked for.
        await resolveBaseForImage(image.imageId).catch((error: unknown) => {
            log.warn({ error, imageId: image.imageId }, "Could not resolve the base image boundary");
        });
        stats.filled += 1;
    }

    return stats;
}

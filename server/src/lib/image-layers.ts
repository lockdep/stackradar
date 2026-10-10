/**
 * The image facts an SBOM upload carries on `metadata.component.properties`
 * (component tier plan, item 5): the ordered layer list, and a flat map of
 * `stackradar:image:*` facts. Pure — the ingest path, the registry backfill
 * and the tests all read the same shapes.
 *
 * The scanner and the CLI write these properties (`stackradar-scanner`
 * `src/lib/image-metadata.ts` is the disclosure boundary; its README lists
 * every name). A scanner older than 0.4.0 sends none, which is not an error:
 * everything here then comes back empty.
 *
 * Layers are indexed by **history entry**, empty ones included, because the
 * base-boundary heuristics read the `CMD` / `ENTRYPOINT` entries that make no
 * layer. `rootfsIndex` is the position among the layers that exist — the
 * number `components.layer_index` holds and "9 of 14 layers" counts.
 */

const LAYER_PROPERTY = /^stackradar:layer:(\d+):(diffId|createdBy|emptyLayer|size|created)$/;
const IMAGE_PROPERTY_PREFIX = "stackradar:image:";
const SYFT_LAYER_ID = /^syft:location:\d+:layerID$/;

/** A sane ceiling; OCI images stop at 127 layers, history adds the empty entries. */
const MAX_LAYER_ENTRIES = 1024;

/**
 * The scanner release that first ran syft with `--scope deep-squashed`.
 * Below it, an OS package's layer is the layer of the package *database* —
 * the last layer that ran apk / dnf — so `layer_index` of an `os`-tier
 * component cannot be trusted (item 6 gates `from_base` on this).
 */
export const DEEP_SQUASHED_SCANNER_VERSION = "0.4.0";

export interface ParsedLayer {
    /** History position, empty entries included. */
    index: number;
    /** Position among the layers that exist; null for an empty entry. */
    rootfsIndex: number | null;
    diffId: string | null;
    createdBy: string | null;
    emptyLayer: boolean;
    size: number | null;
    created: Date | null;
}

export interface ParsedImageMetadata {
    layers: ParsedLayer[];
    /** `stackradar:image:baseName` → `baseName`; env keys as `env:NODE_VERSION`. */
    facts: Record<string, string>;
}

type Property = { name?: unknown; value?: unknown };

/** Read the image metadata off a raw CycloneDX document. Tolerates anything. */
export function parseImageMetadata(rawBom: unknown): ParsedImageMetadata {
    const empty: ParsedImageMetadata = { layers: [], facts: {} };
    if (typeof rawBom !== "object" || rawBom === null) return empty;
    const metadata = (rawBom as { metadata?: unknown }).metadata;
    if (typeof metadata !== "object" || metadata === null) return empty;
    const component = (metadata as { component?: unknown }).component;
    if (typeof component !== "object" || component === null) return empty;
    const properties = (component as { properties?: unknown }).properties;
    if (!Array.isArray(properties)) return empty;

    const byIndex = new Map<number, Partial<Record<"diffId" | "createdBy" | "emptyLayer" | "size" | "created", string>>>();
    const facts: Record<string, string> = {};

    for (const p of properties as Property[]) {
        if (typeof p?.name !== "string" || typeof p.value !== "string") continue;
        const layer = LAYER_PROPERTY.exec(p.name);
        if (layer) {
            const index = Number(layer[1]);
            if (index >= MAX_LAYER_ENTRIES) continue;
            const entry = byIndex.get(index) ?? {};
            entry[layer[2] as keyof typeof entry] = p.value;
            byIndex.set(index, entry);
        } else if (p.name.startsWith(IMAGE_PROPERTY_PREFIX)) {
            facts[p.name.slice(IMAGE_PROPERTY_PREFIX.length)] = p.value;
        }
    }

    let rootfsIndex = 0;
    const layers: ParsedLayer[] = [...byIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, e]) => {
            // `diffId` is what makes an entry a layer; `emptyLayer` alone is
            // not trusted to say so, in either direction.
            const diffId = e.diffId && e.diffId.length <= 128 ? e.diffId : null;
            const size = e.size !== undefined && /^\d+$/.test(e.size) ? Number(e.size) : null;
            const created = e.created ? new Date(e.created) : null;
            return {
                index,
                rootfsIndex: diffId ? rootfsIndex++ : null,
                diffId,
                createdBy: e.createdBy ?? null,
                emptyLayer: diffId === null,
                size,
                created: created && !Number.isNaN(created.getTime()) ? created : null,
            };
        });

    return { layers, facts };
}

/** `diff id → rootfs index`, the lookup {@link resolveLayerIndex} reads. */
export function layerIndexByDiffId(
    layers: ReadonlyArray<{ diffId: string | null; rootfsIndex: number | null }>
): Map<string, number> {
    const map = new Map<string, number>();
    for (const l of layers) if (l.diffId && l.rootfsIndex !== null && !map.has(l.diffId)) map.set(l.diffId, l.rootfsIndex);
    return map;
}

/**
 * The earliest layer a component exists in: the **minimum** resolved index
 * over all its `syft:location:N:layerID` properties, never location 0 alone.
 *
 * Location 0 of a deb package under syft's squashed scope is
 * `/var/lib/dpkg/status`, which belongs to the last layer that ran apt; its
 * copyright and `info/*.list` locations keep the layer it really came from.
 * Under deep-squashed the locations run earliest-first and the minimum is the
 * same answer, so one rule serves SBOMs old and new. Null when nothing
 * resolves — an old scanner, or a layer list that does not name the id.
 */
export function resolveLayerIndex(
    properties: Iterable<{ name: string; value: string }>,
    byDiffId: ReadonlyMap<string, number>
): number | null {
    if (byDiffId.size === 0) return null;
    let min: number | null = null;
    for (const p of properties) {
        if (!SYFT_LAYER_ID.test(p.name)) continue;
        const index = byDiffId.get(p.value);
        if (index !== undefined && (min === null || index < min)) min = index;
    }
    return min;
}

/**
 * Whether an SBOM's layer ids can be trusted for OS packages: written by a
 * scanner at or above {@link DEEP_SQUASHED_SCANNER_VERSION}, or by the
 * platform scan, which says its scope in its provenance string
 * (`platform/linux/amd64@deep-squashed`).
 */
export function layerAttributionTrusted(scannerVersion: string | null | undefined): boolean {
    if (scannerVersion?.startsWith("platform/")) return scannerVersion.endsWith("@deep-squashed");
    return scannerVersionAtLeast(scannerVersion, DEEP_SQUASHED_SCANNER_VERSION);
}

/** `0.4.0` ≤ `0.10.1-rc.1`; anything unparseable (`unknown`, null) is "older". */
export function scannerVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
    const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4).map(Number);
    const have = version ? parse(version) : undefined;
    const want = parse(minimum);
    if (!have || !want) return false;
    for (let i = 0; i < 3; i++) {
        if (have[i]! !== want[i]!) return have[i]! > want[i]!;
    }
    return true;
}

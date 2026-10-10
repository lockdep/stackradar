/**
 * Where an image's base ends and the customer's own layers begin —
 * `images.base_layer_count`, and from it `components.from_base`.
 *
 * Tier says what kind of package a finding is in. The boundary says whose
 * layer put it there, which is the better answer when it is known: an
 * `apt-get install` in the customer's own Dockerfile is an OS package *and*
 * theirs to fix, and the node base image's bundled tooling is not. Where the
 * boundary is not known, `from_base` stays null and the tier stands in.
 *
 * Pure. The caller supplies what needs a database or a registry — the chains
 * of known public images, the org's other images — and this decides. Signals,
 * strongest first; the first to fire wins and is recorded:
 *
 *   1. `annotation`  the image names its base (`org.opencontainers.image.base.*`,
 *                    scanner ≥ 0.4.0). The count comes from a known chain of
 *                    that name, or from the registry (the nightly pass); the
 *                    base is *named* even while the count is unknown.
 *   2. `known-image` the first k layers are exactly the layers of a public
 *                    image we know (`known_layer_prefixes`). The longest such
 *                    k below the image's own length: debian ⊂ node ⊂ app
 *                    answers "node".
 *   3. `org-prefix`  two images of one org share a prefix of ≥ 2 layers — an
 *                    internal golden base. Named when one of them *is* the
 *                    prefix; otherwise "your shared base", unnamed.
 *   4. `buildpacks`  the lifecycle label names the run image and its top
 *                    layer. Exact for images with no Dockerfile history;
 *                    ordered here only until the label shape is confirmed on
 *                    a real Paketo image.
 *   5. `history`     a base image ends with its own `CMD` / `ENTRYPOINT`, and
 *                    its layers are older than the customer's. A `CMD` entry
 *                    followed by more layers, *agreeing with* the largest jump
 *                    in layer build time, marks the boundary. Unnamed. When
 *                    the two disagree there is no boundary.
 *   6. nothing       → null, and `from_base` stays null.
 *
 * A boundary is always a strict prefix: an image that *is* a known image has
 * no customer layers, and that is `lib/image-control.ts`'s `known-image`
 * signal, not a base.
 */

import { createHash } from "node:crypto";

export const BASE_SIGNALS = ["annotation", "known-image", "org-prefix", "buildpacks", "history"] as const;
export type BaseSignal = (typeof BASE_SIGNALS)[number];

/** One history entry, as `image_layers` stores it. */
export interface BaseLayer {
    /** Null for an entry that made no layer. */
    rootfsIndex: number | null;
    diffId: string | null;
    createdBy: string | null;
    builtAt: Date | null;
}

export interface KnownChain {
    /** How many layers the known image has — all of them matched. */
    depth: number;
    imageRef: string;
}

export interface OrgSibling {
    imageRef: string | null;
    diffIds: readonly string[];
}

export interface BaseInput {
    layers: readonly BaseLayer[];
    /** `images.metadata` — `baseName`, `baseDigest`, `buildpackRunImage`, `buildpackTopLayer`. */
    facts: Readonly<Record<string, string>> | null;
    /** Known public images whose whole chain is a prefix of this image, from {@link prefixHashes}. */
    knownChains: readonly KnownChain[];
    /** The org's other images' layer chains. */
    siblings: readonly OrgSibling[];
}

export interface BaseVerdict {
    /** Null when the boundary is known and the base is not named. */
    baseImageRef: string | null;
    /** Layers (that exist) belonging to the base. Null when only the name is known. */
    baseLayerCount: number | null;
    detectedBy: BaseSignal;
}

/** The ordered diff ids of the layers that exist. */
export function chainOf(layers: readonly BaseLayer[]): string[] {
    return layers
        .filter((l): l is BaseLayer & { diffId: string; rootfsIndex: number } => l.diffId !== null && l.rootfsIndex !== null)
        .sort((a, b) => a.rootfsIndex - b.rootfsIndex)
        .map((l) => l.diffId);
}

/**
 * The hash of a layer chain — `known_layer_prefixes.diff_id_prefix_hash`. A
 * known image is stored under the hash of its *whole* chain, so "the first k
 * layers of this image equal all k layers of a known image" is one indexed
 * lookup per k rather than an array comparison per known image.
 */
export function chainHash(diffIds: readonly string[]): string {
    return createHash("sha256").update(diffIds.join("\n")).digest("hex");
}

/** `[hash of first 1, hash of first 2, …, hash of all n]` — what the caller looks up. */
export function prefixHashes(diffIds: readonly string[]): string[] {
    const hashes: string[] = [];
    const hash = createHash("sha256");
    diffIds.forEach((id, i) => {
        hash.update(i === 0 ? id : `\n${id}`);
        hashes.push(hash.copy().digest("hex"));
    });
    return hashes;
}

/** `node:20-bookworm-slim` ≡ `docker.io/library/node:20-bookworm-slim`, for comparing a name with a known ref. */
function bareRef(ref: string): string {
    return ref
        .toLowerCase()
        .replace(/^(index\.)?docker\.io\//, "")
        .replace(/^library\//, "")
        .replace(/@sha256:[0-9a-f]+$/, "");
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

const ENDS_A_STAGE = /^(?:\/bin\/sh -c #\(nop\)\s+)?(CMD|ENTRYPOINT)\b/;

/**
 * Signal 5. Candidate boundaries are the layer counts at each `CMD` /
 * `ENTRYPOINT` entry that more layers follow; the time boundary is where the
 * largest gap between consecutive layers' build times falls. They must name
 * the same place. A reproducible build stamps every layer with one time, so
 * a gap of zero — or a tie for largest — is no evidence, and no boundary.
 */
export function historyBoundary(layers: readonly BaseLayer[]): number | null {
    const total = layers.filter((l) => l.diffId !== null).length;
    if (total < 2) return null;

    const candidates = new Set<number>();
    let seen = 0;
    for (const layer of layers) {
        if (layer.diffId !== null) {
            seen++;
            continue;
        }
        if (layer.createdBy && ENDS_A_STAGE.test(layer.createdBy) && seen > 0 && seen < total) candidates.add(seen);
    }
    if (candidates.size === 0) return null;

    const real = layers.filter((l) => l.diffId !== null);
    let largest = 0;
    let at: number | null = null;
    let tied = false;
    for (let i = 1; i < real.length; i++) {
        const before = real[i - 1]!.builtAt;
        const after = real[i]!.builtAt;
        if (!before || !after) return null;
        const gap = after.getTime() - before.getTime();
        if (gap > largest) {
            largest = gap;
            at = i;
            tied = false;
        } else if (gap === largest && gap > 0) {
            tied = true;
        }
    }
    if (at === null || largest <= 0 || tied) return null;
    return candidates.has(at) ? at : null;
}

export function resolveBase(input: BaseInput): BaseVerdict | null {
    const chain = chainOf(input.layers);
    if (chain.length === 0) return null;

    // A base is a strict prefix; the identical image is not one.
    const bases = input.knownChains.filter((k) => k.depth > 0 && k.depth < chain.length);
    const longestKnown = bases.reduce<KnownChain | null>((best, k) => (best === null || k.depth > best.depth ? k : best), null);

    // 1. The image says what it was built on.
    const baseName = input.facts?.baseName?.trim();
    if (baseName) {
        const named = bases.filter((k) => bareRef(k.imageRef) === bareRef(baseName));
        const match = named.reduce<KnownChain | null>((best, k) => (best === null || k.depth > best.depth ? k : best), null);
        return { baseImageRef: baseName, baseLayerCount: match?.depth ?? null, detectedBy: "annotation" };
    }

    // 2. A known public image is the prefix.
    if (longestKnown) {
        return { baseImageRef: longestKnown.imageRef, baseLayerCount: longestKnown.depth, detectedBy: "known-image" };
    }

    // 3. A golden base inside the org.
    let shared = 0;
    let sharedRef: string | null = null;
    for (const sibling of input.siblings) {
        const n = commonPrefix(chain, sibling.diffIds);
        if (n < 2 || n >= chain.length) continue;
        // The sibling *is* the prefix: it is the base, and it has a name.
        const isBase = n === sibling.diffIds.length;
        if (n > shared || (n === shared && isBase && sharedRef === null)) {
            shared = n;
            sharedRef = isBase ? sibling.imageRef : null;
        }
    }
    if (shared >= 2) return { baseImageRef: sharedRef, baseLayerCount: shared, detectedBy: "org-prefix" };

    // 4. Cloud Native Buildpacks: the run image's top layer is the boundary.
    const topLayer = input.facts?.buildpackTopLayer;
    if (topLayer) {
        const index = chain.indexOf(topLayer);
        if (index >= 0 && index + 1 < chain.length) {
            return {
                baseImageRef: input.facts?.buildpackRunImage ?? null,
                baseLayerCount: index + 1,
                detectedBy: "buildpacks",
            };
        }
    }

    // 5. History: a stage-ending instruction where the build times jump.
    const boundary = historyBoundary(input.layers);
    if (boundary !== null) return { baseImageRef: null, baseLayerCount: boundary, detectedBy: "history" };

    return null;
}

/**
 * `components.from_base` for one component. Null — and the tier stands in —
 * when there is no boundary, no layer, or the layer cannot be trusted: under
 * syft's default scope an apk or rpm package's only location is the package
 * database, which belongs to the last layer that ran the package manager.
 */
export function fromBase(
    component: { layerIndex: number | null; tier: string },
    baseLayerCount: number | null,
    layerAttributionTrusted: boolean
): boolean | null {
    if (baseLayerCount === null || component.layerIndex === null) return null;
    if (component.tier === "os" && !layerAttributionTrusted) return null;
    return component.layerIndex < baseLayerCount;
}

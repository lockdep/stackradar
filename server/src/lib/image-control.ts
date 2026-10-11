/**
 * Who controls an image — the `images.control` column.
 *
 * Tier says what kind of package a finding is in. Control says who can change
 * the image at all, and the two decide which recommendation is even possible:
 * an image the org builds gets dependency bumps and a base rebuild; a
 * third-party image has one action per *image* — upgrade the chart, override
 * the tag, or wait for upstream.
 *
 * Control is a property of the **repository**, not the digest; it is stored
 * on `images` as a derived label so every list can filter on it, and it is
 * never a score (the rule against per-repository scores still holds).
 *
 * Pure. Signals in order, first to fire wins and is recorded:
 *
 *   1. `rule`             an org's own answer (`image_control_rules`). Always wins.
 *   2. `chart`            the image is in the rendered image set of a public
 *                         chart that delivers it here → third-party.
 *   3. `official-image`   the manifest carries Docker Official Images
 *                         annotations, wherever it was mirrored to → third-party.
 *                         Ordered before the registry signal on purpose: it is
 *                         the fix for the mirrored-vendor-image trap.
 *   4. `private-registry` the registry is not a public one → built.
 *   5. `known-image` / `built-on-known`
 *                         the layers are exactly, or start with, an image the
 *                         chart index has scanned (item 6 supplies this).
 *   6. `public-registry`  a well-known vendor namespace → third-party.
 *   7. nothing            → unknown, which recommendations treat like `built`:
 *                         over-recommending on an unknown image is cheap,
 *                         hiding a fix on an image the org builds is not.
 *
 * "control", "built" and "unknown" are internal words. The UI says "Yours",
 * "Third-party", "In your control", "Waiting on upstream".
 */

import { isPublicRegistry, normalizeRegistry, pairRepository } from "./public-registries.js";

export const IMAGE_CONTROLS = ["built", "third-party", "unknown"] as const;
export type ImageControl = (typeof IMAGE_CONTROLS)[number];

export const CONTROL_SIGNALS = [
    "rule",
    "chart",
    "official-image",
    "private-registry",
    "known-image",
    "built-on-known",
    "public-registry",
] as const;
export type ControlSignal = (typeof CONTROL_SIGNALS)[number];

export interface ControlRule {
    /** Null matches any registry. Compared normalised (`index.docker.io` ≡ `docker.io`). */
    registry: string | null;
    /** A repository, or a prefix ending in `*` (`acme/*`). */
    repository: string;
    control: Exclude<ImageControl, "unknown">;
}

export interface ControlInput {
    registry: string | null;
    repository: string | null;
    rules: readonly ControlRule[];
    /** Public charts that deliver a workload running this image, each with the repositories its renders deploy. */
    deliveringCharts: ReadonlyArray<{ chartName: string; repositories: ReadonlySet<string> }>;
    /** `images.metadata.official === "true"` — scanner ≥ 0.4.0. */
    official: boolean;
    /** The layer comparison against the chart index's known images, when it has run. */
    layerMatch?: "known-image" | "built-on-known" | null;
}

export interface ControlVerdict {
    control: ImageControl;
    detectedBy: ControlSignal | null;
    /** What the confirm prompt shows as the reason — a chart name, a registry host. */
    detail: string | null;
}

/**
 * Namespaces on public registries that only a vendor publishes to. Docker
 * Hub's `library/` is the official images; the others are registries where
 * publishing at all means being the vendor.
 */
const VENDOR_NAMESPACES: ReadonlyArray<{ registry: string; prefix: string }> = [
    { registry: "docker.io", prefix: "library/" },
    { registry: "quay.io", prefix: "" },
    { registry: "registry.k8s.io", prefix: "" },
    { registry: "gcr.io", prefix: "google-" },
    { registry: "mcr.microsoft.com", prefix: "" },
];

function patternMatches(pattern: string, repository: string): boolean {
    return pattern.endsWith("*") ? repository.startsWith(pattern.slice(0, -1)) : pattern === repository;
}

/** The most specific matching rule: a registry-scoped rule beats an unscoped one, then the longer pattern. */
export function matchingRule(
    rules: readonly ControlRule[],
    registry: string | null,
    repository: string,
): ControlRule | null {
    const host = normalizeRegistry(registry);
    let best: ControlRule | null = null;
    let bestRank = -1;
    for (const rule of rules) {
        if (rule.registry !== null && normalizeRegistry(rule.registry) !== host) continue;
        if (!patternMatches(rule.repository, repository)) continue;
        const exact = rule.repository.endsWith("*") ? 0 : 1;
        const rank = (rule.registry !== null ? 1_000_000 : 0) + exact * 100_000 + rule.repository.length;
        if (rank > bestRank) {
            best = rule;
            bestRank = rank;
        }
    }
    return best;
}

/**
 * Whether a chart's rendered image set names this repository. A mirror keeps
 * the upstream path and puts its own project in front
 * (`harbor.corp/quay/prometheus/prometheus`), so a path-suffix match counts —
 * the same "same repository under a different registry is the same image"
 * rule `pairRepository` exists for.
 */
function inImageSet(repositories: ReadonlySet<string>, registry: string | null, repository: string): boolean {
    const canonical = pairRepository(registry, repository);
    if (repositories.has(canonical) || repositories.has(repository)) return true;
    for (const observed of repositories) {
        if (repository.endsWith(`/${observed}`)) return true;
        // `library/nginx` rendered, `dockerhub-proxy/nginx` running.
        if (observed.startsWith("library/") && repository.endsWith(`/${observed.slice("library/".length)}`))
            return true;
    }
    return false;
}

/**
 * Who controls an image, from the strongest signal that fires: the org's own
 * rule, then a public chart that deploys it, then the registry's official
 * flag, a private registry, the layer comparison, and last a vendor namespace
 * on a public registry. `detectedBy: null` means nothing fired (or the row
 * has no repository to judge) and `control` is `unknown`, never a guess.
 */
export function resolveControl(input: ControlInput): ControlVerdict {
    const repository = input.repository;
    // An image row without a repository cannot be named in a rule or a prompt.
    if (!repository) return { control: "unknown", detectedBy: null, detail: null };

    const rule = matchingRule(input.rules, input.registry, repository);
    if (rule) return { control: rule.control, detectedBy: "rule", detail: null };

    for (const chart of input.deliveringCharts) {
        if (inImageSet(chart.repositories, input.registry, repository)) {
            return { control: "third-party", detectedBy: "chart", detail: chart.chartName };
        }
    }

    if (input.official) return { control: "third-party", detectedBy: "official-image", detail: null };

    const host = normalizeRegistry(input.registry);
    if (!isPublicRegistry(input.registry)) return { control: "built", detectedBy: "private-registry", detail: host };

    if (input.layerMatch === "known-image") return { control: "third-party", detectedBy: "known-image", detail: null };
    if (input.layerMatch === "built-on-known") return { control: "built", detectedBy: "built-on-known", detail: null };

    const canonical = pairRepository(input.registry, repository);
    const vendor = VENDOR_NAMESPACES.find((v) => v.registry === host && canonical.startsWith(v.prefix));
    if (vendor)
        return {
            control: "third-party",
            detectedBy: "public-registry",
            detail: `${host}/${vendor.prefix}`.replace(/\/$/, ""),
        };

    return { control: "unknown", detectedBy: null, detail: null };
}

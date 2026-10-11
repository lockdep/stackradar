/**
 * Which `--kube-version` to render a chart with.
 *
 * Some charts branch on `.Capabilities.KubeVersion`, so the render should
 * stand in for a plausible cluster inside the chart's own declared range.
 * The proposal asks for the range midpoint when the mirror supplies one:
 * a bounded range renders at the middle minor, an unbounded one at its
 * minimum (the only version the range demonstrably includes), and no range —
 * or an unparseable one — renders with helm's own default. Never a guess
 * outside the declared range.
 */

import semver from "semver";
import { normalizeKubeRange } from "../lib/kube-constraint.js";

/** Highest `<` / `<=` bound in the range, if it declares one. */
function upperBound(normalised: string): semver.SemVer | null {
    let best: semver.SemVer | null = null;
    for (const token of normalised.split(/\s+/)) {
        const match = /^<=?v?(\d+(?:\.\d+){0,2})/.exec(token);
        if (!match) continue;
        const coerced = semver.coerce(match[1]!);
        if (coerced && (best === null || semver.gt(coerced, best))) best = coerced;
    }
    return best;
}

export function renderKubeVersion(kubeRange: string | null | undefined): string | null {
    if (!kubeRange) return null;
    const normalised = normalizeKubeRange(kubeRange);
    if (normalised === null) return null;

    const min = semver.minVersion(normalised);
    if (!min) return null;

    const max = upperBound(normalised);
    if (max && max.major === min.major && semver.gte(max, min)) {
        const midMinor = Math.floor((min.minor + max.minor) / 2);
        return `${min.major}.${midMinor}.0`;
    }
    // Unbounded (or cross-major, where a "midpoint" is not meaningful): the
    // minimum is the one version the range provably includes.
    return `${min.major}.${min.minor}.${min.patch}`;
}

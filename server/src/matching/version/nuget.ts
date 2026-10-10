/**
 * NuGet package versions.
 *
 * https://learn.microsoft.com/en-us/nuget/concepts/package-versioning
 *
 * Semver plus a fourth `Revision` component, and case-insensitive prerelease
 * tags — `1.0.0-BETA` and `1.0.0-beta` are the same version. Ported from
 * osv-scalibr `semantic/version-nuget.go`.
 */

import { compareBuildComponents, parseSemverLikeVersion } from "./semver-like.js";
import { compareComponentLists } from "./shared.js";
import type { Comparison } from "./types.js";

/** Optional `v`, one to four numeric components, semver-style tails. */
const WELL_FORMED = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function compareNuget(a: string, b: string): Comparison {
    const va = parseSemverLikeVersion(a, 4);
    const vb = parseSemverLikeVersion(b, 4);

    const confidence = WELL_FORMED.test(a) && WELL_FORMED.test(b) ? "exact" : "fuzzy";

    const components = compareComponentLists(va.components, vb.components);
    if (components !== 0) return { cmp: components, confidence };

    return {
        cmp: compareBuildComponents(va.build.toLowerCase(), vb.build.toLowerCase()),
        confidence,
    };
}

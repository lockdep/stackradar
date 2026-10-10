/**
 * Semantic Versioning 2.0.0 — https://semver.org/spec/v2.0.0.html
 *
 * Used for the ecosystems that declare semver natively (npm, crates.io, Hex,
 * SwiftURL) and for every OSV `SEMVER`-typed range regardless of ecosystem,
 * which is what the OSV schema means by that range type. Go declares semver too
 * but gets its own scheme, because the *tooling* spells stdlib versions
 * `go1.24.1` — see `golang.ts`, which normalizes and then delegates here.
 *
 * The parser is deliberately more permissive than the spec: it accepts a
 * leading `v`, fewer or more than three numeric components, and an arbitrary
 * tail. That permissiveness is why `wellFormed` exists — a string the spec
 * would reject still gets an ordering, but one flagged `fuzzy` so the caller
 * knows the answer was inferred rather than derived.
 *
 * The one thing that does not get an ordering is a string with *no* numeric
 * component at all — anything whose first character is a letter other than
 * `v`, such as `go1.26.4-X:jsonv2` or `abc`. The parser reads the whole thing
 * as a build tail, and a version with no components sorts below every bound:
 * affected by every `introduced: "0"` range and by none of the ranges for its
 * actual release. That is not a fuzzy guess, it is a confident wrong answer,
 * so the pair comes back `null` (indeterminate) and the caller's fallback
 * scheme, if any, gets to read it instead.
 */

import { compareBuildComponents, parseSemverLikeVersion } from "./semver-like.js";
import { compareComponentLists } from "./shared.js";
import type { Comparison } from "./types.js";

/**
 * Strict-enough semver: optional `v`, one to three numeric components, and the
 * spec's prerelease and build tails. Everything this rejects (`1.0.2k`,
 * `1.2.3.4`, `2020-01-01`) still parses, but only fuzzily.
 */
const WELL_FORMED =
    /^v?(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function isWellFormedSemver(str: string): boolean {
    return WELL_FORMED.test(str);
}

export function compareSemver(a: string, b: string): Comparison {
    const va = parseSemverLikeVersion(a, 3);
    const vb = parseSemverLikeVersion(b, 3);

    // Nothing numeric to order by on one side: not orderable, not "lowest".
    if (va.components.length === 0 || vb.components.length === 0) return null;

    const confidence = isWellFormedSemver(a) && isWellFormedSemver(b) ? "exact" : "fuzzy";

    const components = compareComponentLists(va.components, vb.components);
    if (components !== 0) return { cmp: components, confidence };

    return { cmp: compareBuildComponents(va.build, vb.build), confidence };
}

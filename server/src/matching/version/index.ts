/**
 * Version comparison — the public surface of `matching/version/`.
 *
 * One entry point, `compare(a, b, scheme)`, which dispatches to the comparator
 * for `scheme` and returns an ordering with a confidence, or `null` when the
 * pair is genuinely not orderable.
 *
 * Nothing outside this directory should import a comparator module directly:
 * the empty-version guard and the dual-format retry live here, and skipping
 * them is how "unknown" quietly becomes "equal".
 */

import { compareApk } from "./apk.js";
import { compareComposer } from "./composer.js";
import { compareDpkg } from "./dpkg.js";
import { compareFuzzy } from "./fuzzy.js";
import { compareGem } from "./gem.js";
import { compareGolang } from "./golang.js";
import { compareMaven } from "./maven.js";
import { compareNuget } from "./nuget.js";
import { comparePep440 } from "./pep440.js";
import { compareRpm } from "./rpm.js";
import { compareSemver } from "./semver.js";
import type { Comparison, CompareOptions, Scheme } from "./types.js";

export type { Comparison, CompareOptions, Confidence, Scheme } from "./types.js";

/** Every scheme this module can compare under. */
export const SCHEMES: readonly Scheme[] = [
    "semver",
    "golang",
    "apk",
    "dpkg",
    "rpm",
    "pep440",
    "maven",
    "gem",
    "nuget",
    "composer",
    "fuzzy",
];

function dispatch(a: string, b: string, scheme: Scheme, strict: boolean): Comparison {
    switch (scheme) {
        case "semver":
            return compareSemver(a, b);
        case "golang":
            return compareGolang(a, b);
        case "apk":
            return compareApk(a, b);
        case "dpkg":
            return compareDpkg(a, b, strict);
        case "rpm":
            return compareRpm(a, b, strict);
        case "pep440":
            return comparePep440(a, b);
        case "maven":
            return compareMaven(a, b);
        case "gem":
            return compareGem(a, b);
        case "nuget":
            return compareNuget(a, b);
        case "composer":
            return compareComposer(a, b);
        case "fuzzy":
            return compareFuzzy(a, b);
    }
}

/**
 * Order two version strings under `scheme`.
 *
 * Returns `null` when the pair cannot be ordered — an empty version on either
 * side, or a comparator that could not make sense of its input. `null` is not
 * "equal" and not "not affected"; callers must carry the uncertainty forward.
 *
 * ## Dual-format retry
 *
 * When `opts.fallbackScheme` is given and differs from `scheme`, the primary
 * result is retried under it whenever the primary either failed outright
 * (`null`) or succeeded only fuzzily. This is grype's dual-format retry
 * (`version/version.go:132`) with one adjustment: grype retries on a parse
 * *error*, but the comparators here are near-total — a version they cannot
 * parse usually comes back as a fuzzy ordering rather than an error (the one
 * exception is `semver`, which returns `null` for a string with no numeric
 * component at all), so retrying only on `null` would almost never fire.
 *
 * A fuzzy result is a parse failure the comparator papered over, so it is
 * exactly the case the retry was written for: an Alpine advisory whose bound
 * is written as plain semver parses fuzzily under `apk` and exactly under
 * `semver`. The fallback is adopted only when it is genuinely `exact`, so the
 * retry can upgrade a guess but never replace a confident answer with another
 * scheme's guess.
 */
export function compare(
    a: string,
    b: string,
    scheme: Scheme,
    opts: CompareOptions = {}
): Comparison {
    if (a.trim() === "" || b.trim() === "") return null;

    const strict = opts.strict ?? false;

    const primary = dispatch(a, b, scheme, strict);

    const fallback = opts.fallbackScheme;
    if (fallback == null || fallback === scheme) return primary;
    if (primary !== null && primary.confidence === "exact") return primary;

    const retry = dispatch(a, b, fallback, strict);
    if (retry !== null && retry.confidence === "exact") return retry;

    return primary;
}

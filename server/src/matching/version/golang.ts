/**
 * Go module versions.
 *
 * https://go.dev/doc/modules/version-numbers
 *
 * Go publishes canonical semver (`v1.2.3`, `v0.0.0-20200101120000-abcdef123456`),
 * so this is semver with a normalization pass in front of it. The pass exists
 * because three spellings reach us that semver's grammar rejects, and all three
 * come from the tooling rather than from the module system:
 *
 *   go1.24.1                  the Go stdlib, as syft records it
 *   v1.2.3+incompatible+dirty repeated build metadata, which Go 1.24 emits
 *   9.6.0b1                   a prerelease glued to its release, from advisory
 *                             bounds written by hand
 *
 * Ported from grype `version/golang_version.go`, which fixes up the same three.
 *
 * ## Why this is not just `semver`
 *
 * `parseSemverLike` treats a leading non-digit as the start of the build tail,
 * so `go1.24.1` parses to *no* numeric components. `compareSemver` now refuses
 * to order such a string at all (`null`), which is what lets the dual-format
 * retry in `index.ts` hand the pair to this scheme; before that guard it sorted
 * below every bound, and under the `semver` scheme a Go stdlib component read
 * as "below the range that was introduced at 1.24.0" — a confident miss, and
 * the match was dropped rather than surfaced as `unconfirmed`. That was a
 * silent false-negative class for every `pkg:golang/stdlib` component we
 * ingest, and the GOEXPERIMENT spelling was the same defect in the other
 * direction: below every `introduced: "0"` bound means affected by all of them.
 *
 * ## Confidence
 *
 * Stripping `go`, dropping a GOEXPERIMENT marker and dot-separating repeated
 * build metadata are questions of *spelling*: both sides still order under the
 * real algorithm afterwards, and semver ignores build metadata in comparisons
 * anyway. Those stay `exact`, for
 * the same reason the rpm epoch divergences do (`rpm.ts:34-38`) — flagging them
 * would mark the whole Go ecosystem low-confidence, which is the opposite of
 * what fixing this was for.
 *
 * Repairing a glued-on prerelease is different: `9.6.0b1` is not a spelling of
 * anything Go publishes, so reading it as `9.6.0-b1` is a guess about what the
 * advisory author meant. That one reports `fuzzy`.
 *
 * ## `(devel)`
 *
 * The version the Go toolchain stamps on a binary built outside a module. It
 * names no release and cannot be ordered against one, so it comes back `null` —
 * indeterminate, which `ranges.ts` carries out as `unconfirmed` rather than as a
 * confident miss. grype refuses it too (`golang_version.go:29`), but by dropping
 * the match.
 */

import { compareSemver } from "./semver.js";
import type { Comparison } from "./types.js";

/**
 * The `go` the stdlib carries, stripped only when a digit follows.
 *
 * grype trims the prefix unconditionally. The lookahead is the one place this
 * is deliberately narrower: an unconditional trim rewrites any version that
 * merely starts with those two letters, and a mangled version orders wrongly
 * rather than failing loudly.
 */
const GO_PREFIX = /^go(?=\d)/;

/**
 * A GOEXPERIMENT marker. Go stamps `go1.26.4 X:jsonv2` on a binary built with
 * experiments enabled (`runtime.Version()`), and syft writes the space as `-`,
 * so the stdlib purl reads `pkg:golang/stdlib@1.26.4-X%3Ajsonv2`. The list is
 * comma-separated and ends at end of string or at build metadata.
 *
 * Experiments do not change which release the stdlib is, so the marker is
 * spelling, not a guess: the result stays `exact`. It has to go before anything
 * else looks at the string, because `:` is not a prerelease character and a
 * `-X:` tail turns an otherwise canonical version into one nothing can parse —
 * which, under the `semver` primary `ranges.ts` runs for Go advisories, read as
 * "below every bound": affected by every stdlib advisory ever published, and
 * by none of the ones for its actual release.
 */
const GO_EXPERIMENT = /[-\s]X:[^+\s]*/;

/**
 * A prerelease tag glued straight onto the release, with no `-` separator:
 * `9.6.0b1`. Go modules never publish these — real tags are canonical semver —
 * so such strings only arrive as non-canonical advisory bounds. The tag must
 * begin with a letter immediately after the numeric version, so an
 * already-separated prerelease (`-`) or build metadata (`+`) never matches and
 * only otherwise-unparseable versions are touched.
 */
const GLUED_PRERELEASE = /^(v?\d+\.\d+(?:\.\d+)?)([a-zA-Z].*)$/;

interface NormalizedVersion {
    /** The version rewritten into something semver's grammar accepts. */
    version: string;
    /** Whether the glued-prerelease repair — the one guess — had to fire. */
    repaired: boolean;
}

/** Rewrite a Go version into semver, or `null` when it names no release. */
function normalize(raw: string): NormalizedVersion | null {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "(devel)") return null;

    const stripped = trimmed.replace(GO_EXPERIMENT, "").replace(GO_PREFIX, "");

    // Only the first `+` opens the build metadata; every later one is a
    // separator Go emits and semver does not allow.
    const plus = stripped.indexOf("+");
    const release = plus === -1 ? stripped : stripped.slice(0, plus);
    const metadata = plus === -1 ? null : stripped.slice(plus + 1).replaceAll("+", ".");

    const repaired = GLUED_PRERELEASE.test(release);
    const repairedRelease = repaired ? release.replace(GLUED_PRERELEASE, "$1-$2") : release;

    return {
        version: metadata === null ? repairedRelease : `${repairedRelease}+${metadata}`,
        repaired,
    };
}

export function compareGolang(a: string, b: string): Comparison {
    const va = normalize(a);
    const vb = normalize(b);
    if (va === null || vb === null) return null;

    const result = compareSemver(va.version, vb.version);
    if (result === null) return null;

    // A repair on either side taints the ordering, however well-formed the
    // rewritten pair looks to `compareSemver`.
    if (result.confidence === "exact" && (va.repaired || vb.repaired)) {
        return { cmp: result.cmp, confidence: "fuzzy" };
    }

    return result;
}

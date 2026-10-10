/**
 * Is this version affected? — evaluating one OSV `affected[]` entry.
 *
 * An entry states its affected versions two ways, and an entry may use both:
 *
 *   versions: ["1.0.0", "1.0.1"]                    an explicit list
 *   ranges:   [{ type, events: [{introduced}, …] }] half-open intervals
 *
 * This module turns those into a three-valued answer:
 *
 *   { affected: true }   the version falls inside a stated interval
 *   { affected: false }  every interval was evaluated and none covered it
 *   null                 at least one bound could not be ordered at all
 *
 * The `null` is the whole point. The version comparators return `null` for a
 * pair they cannot order (`version/types.ts`), and that uncertainty has to
 * survive all the way out to the match: an advisory whose `fixed` bound nobody
 * can parse is neither a confirmed hit nor a confirmed miss. Collapsing it
 * either way is how a matcher lies. `match.ts` renders `null` as
 * `confidence: "unconfirmed"` and still reports the match, because the package
 * identity did match — only the version question is open.
 *
 * Confidence rides alongside the verdict. A comparator that had to guess
 * (`version/fuzzy.ts`, or any scheme fed input outside its grammar) reports
 * `fuzzy`, and one fuzzy comparison anywhere in the chain that produced a
 * verdict makes the whole verdict fuzzy.
 */

import type { OsvRange, OsvRangeEvent } from "../db/schema/vulnerabilities.js";
import { schemeForEcosystem } from "./ecosystem.js";
import { compare } from "./version/index.js";
import type { Confidence, Scheme } from "./version/index.js";

// ===== Types =====

/** The parts of an OSV `affected[]` entry that decide the version question. */
export interface AffectedEntry {
    /** Full OSV ecosystem string — names the scheme its bounds are written in. */
    ecosystem: string | null;
    versions: string[] | null;
    ranges: OsvRange[] | null;
}

/** A version verdict, or `null` when the question could not be answered. */
export type Verdict = { affected: boolean; confidence: Confidence } | null;

// ===== Unknown versions =====

/**
 * Is this version string too empty to compare?
 *
 * CycloneDX allows `version` to be absent, and scanners that cannot read a
 * version from a binary write the literal string `"unknown"` rather than
 * omitting the field. Both mean the same thing, and neither may reach a
 * comparator: `"unknown"` would be *parsed* by the permissive comparators and
 * ordered against real versions as though it were one.
 *
 * `(devel)` is the same statement in Go's spelling — what the toolchain stamps
 * on a binary built outside a module. `version/golang.ts` refuses it too, but
 * that is not enough on its own: OSV writes Go advisories as `SEMVER` ranges, so
 * `semver` runs as the primary scheme there and would happily order `(devel)`
 * below every bound as a fuzzy guess. The sentinel has to be caught before any
 * scheme is chosen.
 *
 * grype's `isUnknownVersion` (`grype/version/version.go`).
 */
const UNKNOWN_VERSIONS = new Set(["unknown", "(devel)"]);

export function isUnknownVersion(version: string | null | undefined): boolean {
    if (!version) return true;

    const trimmed = version.trim();
    return trimmed === "" || UNKNOWN_VERSIONS.has(trimmed.toLowerCase());
}

// ===== Event bounds =====

type BoundKind = "introduced" | "fixed" | "last_affected" | "limit";

interface Bound {
    kind: BoundKind;
    value: string;
}

/**
 * The single bound an event states.
 *
 * OSV requires exactly one key per event object. The fixed precedence below is
 * only there so a malformed record with two keys is read the same way every
 * time rather than depending on key insertion order.
 */
function boundOf(event: OsvRangeEvent): Bound | null {
    if (event.introduced !== undefined) return { kind: "introduced", value: event.introduced };
    if (event.fixed !== undefined) return { kind: "fixed", value: event.fixed };
    if (event.last_affected !== undefined) {
        return { kind: "last_affected", value: event.last_affected };
    }
    if (event.limit !== undefined) return { kind: "limit", value: event.limit };

    return null;
}

/** `introduced: "0"` is the OSV idiom for "since the beginning of time". */
function isZeroIntroduced(bound: Bound): boolean {
    return bound.kind === "introduced" && bound.value === "0";
}

/**
 * Sort a range's events into ascending bound order, or return `null` when that
 * order cannot be established.
 *
 * The state machine below walks events in sequence and assumes each bound is at
 * least as high as the last; a `fixed` listed before its `introduced` would
 * close an interval that had not opened. Upstream OSV data is in order — 0.00%
 * of ~950,000 ranges measured had an inversion (Appendix A) — so this is
 * insurance against a single malformed record, not a fix for anything observed.
 *
 * Returning `null` when *any* pair is unorderable, rather than keeping a
 * partial sort, is deliberate. A half-sorted list is worse than the document
 * order it replaced: the document order is at least what the publisher wrote.
 * The caller falls back to it, and the walk's own fail-closed `null` handles
 * the bound that could not be compared — if it is genuinely uncomparable, the
 * walk will hit it too.
 */
function sortEvents(
    events: readonly OsvRangeEvent[],
    scheme: Scheme,
    fallbackScheme: Scheme | null
): OsvRangeEvent[] | null {
    const decorated = events.map((event, index) => ({ event, bound: boundOf(event), index }));

    let undetermined = false;

    const sorted = [...decorated].sort((a, b) => {
        if (undetermined) return 0;

        // Events with no bound at all, and `introduced: "0"`, sort to the front:
        // neither carries a version to order by, and both belong at the start.
        const aFloor = a.bound === null || isZeroIntroduced(a.bound);
        const bFloor = b.bound === null || isZeroIntroduced(b.bound);
        if (aFloor || bFloor) {
            if (aFloor && bFloor) return a.index - b.index;
            return aFloor ? -1 : 1;
        }

        const result = compare(a.bound!.value, b.bound!.value, scheme, { fallbackScheme });
        if (result === null) {
            undetermined = true;
            return 0;
        }

        if (result.cmp !== 0) return result.cmp;

        // Same version: open the interval before closing it, so a range stating
        // `introduced: 1.2` and `fixed: 1.2` reads as empty rather than as
        // everything from 1.2 onward.
        const aOpens = a.bound!.kind === "introduced";
        const bOpens = b.bound!.kind === "introduced";
        if (aOpens !== bOpens) return aOpens ? -1 : 1;

        return a.index - b.index;
    });

    return undetermined ? null : sorted.map((d) => d.event);
}

// ===== The state machine =====

/**
 * Walk one range's events and decide whether `version` falls inside it.
 *
 * The `else if` chain is upstream's (osv-scalibr `internal/osvmatcher`, grype
 * `grype/matcher/internal`): an `introduced` is read only while not affected,
 * and a closing bound only while affected. Once the events are sorted this is
 * equivalent to testing each bound independently, but keeping the same shape as
 * upstream means the two implementations can be diffed line for line when a
 * result disagrees.
 *
 * Any bound that cannot be ordered against the version aborts the whole range
 * with `null`. The alternative — skipping the event — silently converts "we
 * could not read the fix" into "there is no fix", which reports an advisory
 * nobody could evaluate as a confirmed hit forever.
 */
function evaluateRange(
    version: string,
    range: OsvRange,
    scheme: Scheme,
    fallbackScheme: Scheme | null
): Verdict {
    const events = sortEvents(range.events, scheme, fallbackScheme) ?? range.events;

    let affected = false;
    let confidence: Confidence = "exact";

    /** Order `version` against a bound, recording fuzziness. `null` aborts. */
    const against = (bound: string): number | null => {
        const result = compare(version, bound, scheme, { fallbackScheme });
        if (result === null) return null;
        if (result.confidence === "fuzzy") confidence = "fuzzy";
        return result.cmp;
    };

    for (const event of events) {
        if (!affected && event.introduced !== undefined) {
            if (event.introduced === "0") {
                affected = true;
                continue;
            }
            const cmp = against(event.introduced);
            if (cmp === null) return null;
            if (cmp >= 0) affected = true;
        } else if (affected && event.fixed !== undefined) {
            const cmp = against(event.fixed);
            if (cmp === null) return null;
            if (cmp >= 0) affected = false;
        } else if (affected && event.last_affected !== undefined) {
            const cmp = against(event.last_affected);
            if (cmp === null) return null;
            if (cmp > 0) affected = false;
        } else if (affected && event.limit !== undefined) {
            const cmp = against(event.limit);
            if (cmp === null) return null;
            if (cmp >= 0) affected = false;
        }
    }

    return { affected, confidence };
}

/**
 * Combine several ranges: affected by any is affected.
 *
 * The asymmetry in how confidence is carried follows from that. One range
 * saying "yes" settles it, so the answer inherits *that* range's confidence and
 * the others are never consulted. "No" is a claim about all of them, so it is
 * only as good as the weakest comparison made along the way — and a single
 * range that could not be evaluated makes the whole answer `null`, even if
 * every other range cleanly said no.
 */
function evaluateRanges(
    version: string,
    ranges: readonly OsvRange[],
    scheme: Scheme,
    fallbackScheme: Scheme | null
): Verdict {
    let indeterminate = false;
    let confidence: Confidence = "exact";

    for (const range of ranges) {
        const verdict = evaluateRange(version, range, scheme, fallbackScheme);

        if (verdict === null) {
            indeterminate = true;
            continue;
        }
        if (verdict.affected) return verdict;
        if (verdict.confidence === "fuzzy") confidence = "fuzzy";
    }

    return indeterminate ? null : { affected: false, confidence };
}

// ===== Entry point =====

/**
 * Is `version` affected according to this `affected[]` entry?
 *
 * `packageScheme` is how the *component's* ecosystem orders versions, derived
 * from its PURL type. It leads, and the advisory's own scheme is the fallback
 * for the dual-format retry (`version/index.ts`). The two differ only when a
 * record is written against an ecosystem whose PURL type we map elsewhere,
 * which is rare — but when it happens, the component's spelling is the one we
 * are certain about, because we parsed its PURL to get here.
 *
 * Precedence between the two ways an entry states its versions:
 *
 * 1. **The explicit list**, by string equality. It is the publisher naming
 *    exact releases, and 77% of PyPI entries have one.
 * 2. **`SEMVER` ranges**, under semver — the OSV spec defines that range type
 *    as semver-ordered regardless of ecosystem.
 * 3. **`ECOSYSTEM` ranges**, under the schemes described above.
 *
 * Deliberately *not* adopted: osv-scalibr's rule that the first non-`ECOSYSTEM`
 * range suppresses every later range. That is an upstream bug, and it drops
 * real `ECOSYSTEM` bounds from entries that carry both kinds.
 *
 * An entry with a versions list, no usable range, and no match in the list is
 * the one case where a *negative* is confirmed rather than indeterminate: the
 * publisher enumerated the affected releases and this is not one of them.
 */
export function evaluateAffected(
    version: string | null | undefined,
    entry: AffectedEntry,
    packageScheme: Scheme | null
): Verdict {
    if (isUnknownVersion(version)) return null;

    const v = version!.trim();
    const versions = entry.versions ?? [];

    if (versions.includes(v)) return { affected: true, confidence: "exact" };

    const ranges = entry.ranges ?? [];
    const advisoryScheme = schemeForEcosystem(entry.ecosystem);

    const semverRanges = ranges.filter((r) => r.type === "SEMVER");
    if (semverRanges.length > 0) {
        return evaluateRanges(v, semverRanges, "semver", packageScheme);
    }

    const ecosystemRanges = ranges.filter((r) => r.type === "ECOSYSTEM");
    if (ecosystemRanges.length > 0) {
        // No scheme on either side means no comparator claims this ecosystem.
        // `fuzzy` still orders the pair, and flags every result it produces, so
        // the match surfaces as low-confidence rather than not at all.
        const primary = packageScheme ?? advisoryScheme ?? "fuzzy";
        return evaluateRanges(v, ecosystemRanges, primary, advisoryScheme);
    }

    // GIT ranges are the remaining case. They bound commits, not versions, and
    // there is nothing here to compare a package version against.
    if (versions.length > 0) return { affected: false, confidence: "exact" };

    return null;
}

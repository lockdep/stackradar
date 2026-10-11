/**
 * Packagist / Composer version ordering.
 *
 * Ported from osv-scalibr `semantic/version-packagist.go`, which is 1:1 with
 * PHP's native `version_compare` apart from stripping a leading `v` (which
 * Composer, not PHP, does).
 *
 * The version is canonicalized by replacing `-`, `_` and `+` with `.` and
 * inserting a `.` at every digit/non-digit boundary, so `v3.10.0RC1` becomes
 * `3.10.0.RC.1`. Segments are then compared numerically where possible and by
 * a fixed qualifier weight otherwise: `dev` < `a` < `b` < `RC` < (release) <
 * `p`.
 */

import { toBigInt, type Ordering } from "./shared.js";
import type { Comparison } from "./types.js";

const SEPARATORS = /[-_+]/g;
const NON_DIGIT_TO_DIGIT = /([^\d.])(\d)/g;
const DIGIT_TO_NON_DIGIT = /(\d)([^\d.])/g;

function canonicalize(v: string): string {
    if (v.startsWith("v") || v.startsWith("V")) v = v.slice(1);

    v = v.replace(SEPARATORS, ".");
    v = v.replace(NON_DIGIT_TO_DIGIT, "$1.$2");
    v = v.replace(DIGIT_TO_NON_DIGIT, "$1.$2");

    return v;
}

/**
 * Qualifier weights. `#` is the sentinel for "a plain release", which is how a
 * numeric segment is weighed against a qualifier one.
 */
const SPECIALS = ["dev", "a", "b", "rc", "#", "p"];

function weighBuildCharacter(str: string): number {
    // Upstream checks the upper-case form first, so `RC1` outranks `rc`-lower.
    if (str.startsWith("RC")) return 3;

    for (let i = 0; i < SPECIALS.length; i++) {
        if (str.startsWith(SPECIALS[i]!)) return i;
    }

    return 0;
}

function compareSpecials(a: string, b: string): Ordering {
    const av = weighBuildCharacter(a);
    const bv = weighBuildCharacter(b);
    if (av > bv) return 1;
    if (av < bv) return -1;
    return 0;
}

function compareComponents(a: string[], b: string[]): Ordering {
    const min = Math.min(a.length, b.length);

    for (let i = 0; i < min; i++) {
        const ai = toBigInt(a[i]!);
        const bi = toBigInt(b[i]!);

        let compare: Ordering;
        if (ai !== null && bi !== null) {
            compare = ai < bi ? -1 : ai > bi ? 1 : 0;
        } else if (ai === null && bi === null) {
            compare = compareSpecials(a[i]!, b[i]!);
        } else if (ai !== null) {
            compare = compareSpecials("#", b[i]!);
        } else {
            compare = compareSpecials(a[i]!, "#");
        }

        if (compare !== 0) return compare;
    }

    // The longer version wins outright if its next segment is numeric;
    // otherwise that segment is weighed against a plain release.
    if (a.length > b.length) {
        const next = a[b.length]!;
        if (toBigInt(next) !== null) return 1;
        return compareComponents(a.slice(b.length), ["#"]);
    }

    if (a.length < b.length) {
        const next = b[a.length]!;
        if (toBigInt(next) !== null) return -1;
        return compareComponents(["#"], b.slice(a.length));
    }

    return 0;
}

export function parseComposerVersion(str: string): string[] {
    return canonicalize(str).split(".");
}

/**
 * Always `exact`: unlike apk or rpm, there is no such thing as input this
 * scheme cannot parse. PHP's `version_compare` is defined over arbitrary
 * strings, and the canonicalization above turns any input into segments the
 * comparison below handles. There is no "had to guess" case to report.
 */
export function compareComposer(a: string, b: string): Comparison {
    return {
        cmp: compareComponents(parseComposerVersion(a), parseComposerVersion(b)),
        confidence: "exact",
    };
}

/**
 * The last resort: ordering two version strings when no scheme applies.
 *
 * Reached only when the ecosystem has no comparator of its own. Ported from
 * grype `version/fuzzy_version.go` and `version/fuzzy_constraint.go`, which in
 * turn take the string-walking part from Facebook's `nvdtools`.
 *
 * Two stages:
 *
 *  1. If *both* strings match a permissive pseudo-semver pattern, order them
 *     as semver. This covers the large tail of "almost semver" versions.
 *  2. Otherwise walk both strings segment by segment, zero-padding the shorter
 *     numeric run at each step so `1.9` and `1.10` order correctly, and
 *     comparing patch-style suffixes (`p9` vs `p15`) numerically.
 *
 * Every result is `fuzzy`. That is the whole point of this module: it always
 * produces an answer, and the answer is always an inference.
 */

import { compareSemver } from "./semver.js";
import { compareStrings, isDigit, type Ordering } from "./shared.js";
import type { Comparison } from "./types.js";

/**
 * Looser than the semver spec but stricter than "anything with digits" —
 * strict enough that `1.0.2k` falls through to the string walk rather than
 * being mangled into a prerelease of `1.0.2`.
 */
const PSEUDO_SEMVER =
    /^[vV]?(0|[1-9]\d*)(\.(0|[1-9]\d*))?(\.(0|[1-9]\d*))?(?:(-|alpha|beta|rc)((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function stripLeadingV(v: string): string {
    return v.startsWith("v") || v.startsWith("V") ? v.slice(1) : v;
}

/** True for ASCII punctuation — anything that separates two version parts. */
function isPunctuation(c: string): boolean {
    return /[!-/:-@[-`{-~]/.test(c);
}

/**
 * For the head of `v`, return:
 *  - the length of the leading run of digits,
 *  - the index at which the comparable part ends (the separator or end),
 *  - the index to resume from (past the separator).
 *
 * `parseVersionParts("11.b4.16-New_Year")` → `[2, 2, 3]`.
 */
function parseVersionParts(v: string): [number, number, number] {
    let num = 0;
    while (num < v.length && isDigit(v[num])) num++;

    if (num === v.length) return [num, num, num];

    let skip = -1;
    for (let i = 0; i < v.length; i++) {
        if (isPunctuation(v[i]!)) {
            skip = i;
            break;
        }
    }

    if (skip === -1) return [num, v.length, v.length];
    return [num, skip, skip + 1];
}

/** Does this segment look like `p9`, `rc1`, `8p15` — a letter then digits? */
function hasPatchNumber(segment: string): boolean {
    for (let i = 0; i < segment.length - 1; i++) {
        if (/\p{L}/u.test(segment[i]!) && isDigit(segment[i + 1])) return true;
    }
    return false;
}

/** Compare `p9` against `p15` numerically rather than lexically. */
function comparePatchNumbers(left: string, right: string): Ordering {
    const boundary = (s: string): number => {
        for (let i = 0; i < s.length - 1; i++) {
            if (/\p{L}/u.test(s[i]!) && isDigit(s[i + 1])) return i + 1;
        }
        return -1;
    };

    const lp = boundary(left);
    const rp = boundary(right);

    if (lp > 0 && rp > 0) {
        const lPrefix = left.slice(0, lp);
        const rPrefix = right.slice(0, rp);

        const prefixDiff = compareStrings(lPrefix, rPrefix);
        if (prefixDiff !== 0) return prefixDiff;

        const lNum = left.slice(lp);
        const rNum = right.slice(rp);
        if (/^\d+$/.test(lNum) && /^\d+$/.test(rNum)) {
            const a = BigInt(lNum);
            const b = BigInt(rNum);
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
        }
    }

    return compareStrings(left, right);
}

/**
 * Compare two version strings of unspecified convention, assuming they share
 * one. Meaningful for `95SE` vs `98SP1` or `16.3.2` vs `3.7.0`; meaningless
 * for `2000` vs `11.7`, and there is no way for it to know which it was given.
 */
export function fuzzyVersionComparison(v1: string, v2: string): Ordering {
    v1 = stripLeadingV(v1);
    v2 = stripLeadingV(v2);

    let s1 = v1;
    let s2 = v2;

    while (s1.length > 0 && s2.length > 0) {
        const [num1, cmpTo1, skip1] = parseVersionParts(s1);
        const [num2, cmpTo2, skip2] = parseVersionParts(s2);

        let ns1 = s1.slice(0, cmpTo1);
        let ns2 = s2.slice(0, cmpTo2);

        // Pad the shorter numeric run so a string compare orders it correctly.
        const diff = num1 - num2;
        if (diff > 0) ns2 = "0".repeat(diff) + ns2;
        else if (diff < 0) ns1 = "0".repeat(-diff) + ns1;

        if (hasPatchNumber(ns1) && hasPatchNumber(ns2)) {
            const cmp = comparePatchNumbers(ns1, ns2);
            if (cmp !== 0) return cmp;
        } else {
            const cmp = compareStrings(ns1, ns2);
            if (cmp !== 0) return cmp;
        }

        s1 = s1.slice(skip1);
        s2 = s2.slice(skip2);
    }

    // Equal so far — the longer one wins.
    if (v1.length > v2.length) return 1;
    if (v2.length > v1.length) return -1;
    return 0;
}

export function compareFuzzy(a: string, b: string): Comparison {
    if (PSEUDO_SEMVER.test(a) && PSEUDO_SEMVER.test(b)) {
        const semver = compareSemver(a, b);
        if (semver !== null) return { cmp: semver.cmp, confidence: "fuzzy" };
    }

    return { cmp: fuzzyVersionComparison(a, b), confidence: "fuzzy" };
}

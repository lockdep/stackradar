/**
 * RubyGems version ordering.
 *
 * Ported from osv-scalibr `semantic/version-rubygems.go`, which mirrors Ruby's
 * `Gem::Version`.
 *
 * The version is canonicalized by inserting a `.` at every digit/non-digit
 * boundary, so `4.0.0.beta1` and `4.0.0beta1` and `4.0.0.beta.1` are one
 * version. Segments are then split into a leading numeric run and a trailing
 * "build" run; trailing zeros are dropped from each independently, which is
 * how `1.0` and `1.0.0` stay equal.
 *
 * Any letter segment makes the version a prerelease: because a string segment
 * always sorts below a numeric one, `4.0.0.beta1` lands below `4.0.0`.
 *
 * 24.8% of RubyGems version strings in the OSV export are not semver.
 */

import { compareStrings, fetch, sign, toBigInt, type Ordering } from "./shared.js";
import type { Comparison } from "./types.js";

/** Insert a `.` at every digit/non-digit boundary. */
function canonicalize(str: string): string {
    let out = "";
    let checkPrevious = false;
    let previousWasDigit = true;

    for (const c of str) {
        if (c === ".") {
            checkPrevious = false;
            out += ".";
            continue;
        }

        const isDigit = c >= "0" && c <= "9";
        if (checkPrevious && previousWasDigit !== isDigit) out += ".";

        out += c;
        previousWasDigit = isDigit;
        checkPrevious = true;
    }

    return out;
}

/** Split into the leading run of numeric segments and everything after it. */
function groupSegments(segs: string[]): { numbers: string[]; build: string[] } {
    const numbers: string[] = [];
    const build: string[] = [];

    for (const seg of segs) {
        if (build.length > 0 || toBigInt(seg) === null) {
            build.push(seg);
            continue;
        }
        numbers.push(seg);
    }

    return { numbers, build };
}

/** Drop trailing `0` segments. */
function removeZeros(segs: string[]): string[] {
    let i = segs.length - 1;
    while (i >= 0) {
        if (segs[i] !== "0") {
            i++;
            break;
        }
        i--;
    }
    return segs.slice(0, Math.max(i, 0));
}

export function parseGemVersion(str: string): string[] {
    const segs = canonicalize(str).split(".");
    const { numbers, build } = groupSegments(segs);
    return [...removeZeros(numbers), ...removeZeros(build)];
}

function compareSegments(a: string[], b: string[]): Ordering {
    const len = Math.max(a.length, b.length);

    for (let i = 0; i < len; i++) {
        const as = fetch(a, i, "0");
        const bs = fetch(b, i, "0");

        const ai = toBigInt(as);
        const bi = toBigInt(bs);

        if (ai !== null && bi !== null) {
            const diff = sign(ai - bi);
            if (diff !== 0) return diff;
        } else if (ai === null && bi === null) {
            const diff = compareStrings(as, bs);
            if (diff !== 0) return diff;
        } else if (ai !== null) {
            // A numeric segment outranks a letter segment, which is what makes
            // any letter segment a prerelease marker.
            return 1;
        } else {
            return -1;
        }
    }

    return 0;
}

/**
 * Ruby's `Gem::Version::ANCHORED_VERSION_PATTERN` — the pattern RubyGems
 * itself rejects a version for failing. The segment comparison below accepts
 * any string, so without this check the comparator would claim `exact` for
 * input RubyGems would refuse to parse at all.
 */
const WELL_FORMED = /^\s*([0-9]+(\.[0-9a-zA-Z]+)*(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?)?\s*$/;

export function compareGem(a: string, b: string): Comparison {
    const confidence = WELL_FORMED.test(a) && WELL_FORMED.test(b) ? "exact" : "fuzzy";
    return { cmp: compareSegments(parseGemVersion(a), parseGemVersion(b)), confidence };
}

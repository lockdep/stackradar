/**
 * Maven version ordering.
 *
 * https://maven.apache.org/pom.html#version-order-specification
 *
 * Ported from osv-scalibr `semantic/version-maven.go`, which follows Maven's
 * own `ComparableVersion` rather than the (underspecified) written spec where
 * the two disagree.
 *
 * A version is split into tokens at `.`, at `-`, and at every transition
 * between digits and non-digits, so `9.3.0.v20150612` and `3.2.0rc2` both
 * decompose cleanly. Each token remembers the separator that preceded it,
 * because the separator changes the ordering: `.qualifier` < `-qualifier` <
 * `-number` < `.number`. Trailing "null" tokens (`0`, ``, `final`, `ga`) are
 * trimmed so `1.0` and `1.0.0-ga` are the same version.
 *
 * 19.8% of the 636k Maven version strings in the OSV export are not semver.
 */

import { toBigInt } from "./shared.js";
import type { Comparison } from "./types.js";

interface Token {
    /** `""` for the first token, otherwise `.` or `-`. */
    prefix: string;
    value: string;
    /** True for tokens synthesised while padding the shorter version. */
    isNull: boolean;
}

/**
 * Known qualifiers, in order. Anything not listed sorts after all of them —
 * Maven's implementation does this even though the spec does not say so.
 */
const KEYWORD_ORDER = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];

function keywordOrder(keyword: string): number {
    const i = KEYWORD_ORDER.indexOf(keyword);
    return i === -1 ? KEYWORD_ORDER.length : i;
}

/** `.qualifier` (0) < `-qualifier` (1) < `-number` (2) < `.number` (3). */
function qualifierOrder(t: Token): number | null {
    const numeric = toBigInt(t.value) !== null;

    if (numeric) {
        if (t.prefix === "-") return 2;
        if (t.prefix === ".") return 3;
    }
    if (t.prefix === "-") return 1;
    if (t.prefix === ".") return 0;

    return null;
}

function shouldTrim(t: Token): boolean {
    return t.value === "0" || t.value === "" || t.value === "final" || t.value === "ga";
}

function tokensEqual(a: Token, b: Token): boolean {
    return a.prefix === b.prefix && a.value === b.value;
}

function tokenLessThan(a: Token, b: Token): boolean | null {
    if (a.prefix === b.prefix) {
        const av = toBigInt(a.value);
        const bv = toBigInt(b.value);

        // Numeric tokens have their natural order.
        if (av !== null && bv !== null) return av < bv;

        // Numerics sort after non-numerics — unless the numeric is a padded
        // null value, which is how `1` and `1.0` stay equal.
        if (av !== null && !a.isNull) return false;
        if (bv !== null && !b.isNull) return true;

        const ai = keywordOrder(a.value);
        const bi = keywordOrder(b.value);

        // Two unknown qualifiers: plain lexical order.
        if (ai === KEYWORD_ORDER.length && bi === KEYWORD_ORDER.length) {
            return a.value < b.value;
        }

        return ai < bi;
    }

    const ao = qualifierOrder(a);
    const bo = qualifierOrder(b);
    if (ao === null || bo === null) return null;
    return ao < bo;
}

/**
 * The value the shorter version is padded with, which depends on the separator
 * of the token it is being compared against: `0` for `.`, `""` for `-`.
 */
function nullTokenFor(token: Token): Token | null {
    if (token.prefix === ".") {
        // `sp` is the one qualifier that sorts *after* an empty value, and the
        // comparator can only express that by padding with "" instead of "0".
        return { prefix: ".", value: token.value === "sp" ? "" : "0", isNull: true };
    }
    if (token.prefix === "-") {
        return { prefix: "-", value: "", isNull: true };
    }
    return null;
}

/** Split on `-` and `.`, keeping the separators as their own entries. */
function splitCharsInclusive(s: string, chars: string): string[] {
    const out: string[] = [];
    for (;;) {
        let m = -1;
        for (const c of chars) {
            const i = s.indexOf(c);
            if (i !== -1 && (m === -1 || i < m)) m = i;
        }
        if (m < 0) break;
        out.push(s.slice(0, m), s.slice(m, m + 1));
        s = s.slice(m + 1);
    }
    out.push(s);
    return out;
}

/**
 * Every index at which a token flips between digit and non-digit. Maven treats
 * those as if a hyphen were present, so `1.0rc2` tokenizes like `1.0-rc-2`.
 */
function findTransitions(token: string): number[] {
    const ints: number[] = [];
    for (let i = 1; i < token.length; i++) {
        const prev = token[i - 1]!;
        const cur = token[i]!;
        const prevDigit = prev >= "0" && prev <= "9";
        const curDigit = cur >= "0" && cur <= "9";
        if (prevDigit !== curDigit) ints.push(i);
    }
    return ints;
}

export function parseMavenVersion(str: string): Token[] {
    const tokens: Token[] = [];
    const rawTokens = splitCharsInclusive(str, "-.");

    for (let i = 0; i < rawTokens.length; i += 2) {
        // The preceding separator, or nothing for the first token.
        let prefix = i === 0 ? "" : rawTokens[i - 1]!;

        const raw = rawTokens[i]!;
        const transitions = [...findTransitions(raw), raw.length];

        let prevIndex = 0;
        for (let j = 0; j < transitions.length; j++) {
            const transition = transitions[j]!;
            // Splits introduced by a digit/non-digit flip behave as hyphens.
            if (j > 0) prefix = "-";

            // All qualifiers are case-insensitive; the spec omits this.
            let current = raw.slice(prevIndex, transition).toLowerCase();

            if (current === "") current = "0";
            // `cr` and `rc` are equal in precedence.
            if (current === "cr") current = "rc";
            // `ga`, `final` and (per Maven, not the spec) `release` mean "no
            // qualifier at all".
            if (current === "ga" || current === "final" || current === "release") current = "";

            // `a`, `b` and `m` abbreviate `alpha`, `beta` and `milestone`, but
            // only when directly followed by a number.
            if (transition !== raw.length) {
                if (current === "a") current = "alpha";
                if (current === "b") current = "beta";
                if (current === "m") current = "milestone";
            }

            // Drop leading zeros so `1.01` and `1.1` are one version.
            const d = toBigInt(current);
            if (d !== null) current = d.toString();

            tokens.push({ prefix, value: current, isNull: false });
            prevIndex = transition;
        }
    }

    // Trim trailing null values, repeating from each remaining hyphen backwards.
    let i = tokens.length - 1;
    while (i > 0) {
        if (shouldTrim(tokens[i]!)) {
            tokens.splice(i, 1);
            i--;
            continue;
        }
        while (i >= 0 && tokens[i]!.prefix !== "-") i--;
        i--;
    }

    return tokens;
}

function versionsEqual(a: Token[], b: Token[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((t, i) => tokensEqual(t, b[i]!));
}

function versionLessThan(a: Token[], b: Token[]): boolean | null {
    const len = Math.max(a.length, b.length);

    for (let i = 0; i < len; i++) {
        // Pad the shorter side with nulls that mirror the other's separator.
        const left = i >= a.length ? nullTokenFor(b[i]!) : a[i]!;
        const right = i >= b.length ? nullTokenFor(a[i]!) : b[i]!;
        if (left === null || right === null) return null;

        // Keep padding until the versions actually differ.
        if (tokensEqual(left, right)) continue;

        return tokenLessThan(left, right);
    }

    return false;
}

/**
 * Always `exact` when it returns at all: Maven's `ComparableVersion` is total
 * by design — every string is a valid Maven version, tokenized by the rules
 * above — so there is no "had to guess" case to report.
 */
export function compareMaven(a: string, b: string): Comparison {
    const va = parseMavenVersion(a);
    const vb = parseMavenVersion(b);

    if (versionsEqual(va, vb)) return { cmp: 0, confidence: "exact" };

    const lt = versionLessThan(va, vb);
    // A token with a separator we do not recognise leaves the pair unordered.
    if (lt === null) return null;

    return { cmp: lt ? -1 : 1, confidence: "exact" };
}

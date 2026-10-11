/**
 * Primitives shared by the version comparators.
 *
 * Numeric components are compared as `bigint`, not `number`. Real version
 * strings carry date-like and hash-like components (`v0.0.1.20200106`,
 * `1.0.0.20240705`) that exceed the exact-integer range often enough to matter,
 * and upstream (osv-scalibr) uses arbitrary-precision integers throughout — a
 * `number` port would silently disagree with the conformance corpora.
 */

/** Ordering of two values, normalized to the -1/0/1 the comparators return. */
export type Ordering = -1 | 0 | 1;

export function isDigit(c: string | undefined): boolean {
    return c !== undefined && c >= "0" && c <= "9";
}

export function isAlpha(c: string | undefined): boolean {
    return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
}

/** Normalize any comparison result (number or bigint) to -1/0/1. */
export function sign(n: number | bigint): Ordering {
    if (n < 0) return -1;
    if (n > 0) return 1;
    return 0;
}

/** Strict base-10 comparison of two strings, mirroring Go's `strings.Compare`. */
export function compareStrings(a: string, b: string): Ordering {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Parse a string as an integer, or return null when it is not purely numeric.
 *
 * Mirrors Go's `big.Int.SetString(str, 10)`: an optional sign followed by at
 * least one digit, nothing else. Several comparators use a failed parse as the
 * definition of "this segment is a qualifier, not a number", so being stricter
 * or looser than upstream here changes ordering, not just error handling.
 */
export function toBigInt(str: string): bigint | null {
    if (!/^[+-]?\d+$/.test(str)) return null;
    return BigInt(str);
}

/** Element at `i`, or `def` when the index is past the end. */
export function fetch<T>(arr: readonly T[], i: number, def: T): T {
    return i < arr.length ? arr[i]! : def;
}

/**
 * Compare two lists of numeric components, zero-padding the shorter one.
 * `1.2` and `1.2.0` are equal under this rule, which is what every
 * dotted-numeric scheme here expects.
 */
export function compareComponentLists(a: readonly bigint[], b: readonly bigint[]): Ordering {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const diff = sign(fetch(a, i, 0n) - fetch(b, i, 0n));
        if (diff !== 0) return diff;
    }
    return 0;
}

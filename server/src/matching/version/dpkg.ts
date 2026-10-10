/**
 * dpkg version ordering — Debian, Ubuntu.
 *
 * Format `[epoch:]upstream[-revision]`.
 * See https://man7.org/linux/man-pages/man7/deb-version.7.html
 *
 * Ported from osv-scalibr `semantic/version-debian.go`.
 *
 * ## Two deliberate divergences from native dpkg
 *
 * Both apply only when `strict` is off, which is how the matcher always calls
 * this. They exist because we are not ordering two versions from the same
 * archive — we are comparing an advisory's bound against whatever the scanner
 * read off a running container, and the two are written to different levels of
 * detail.
 *
 * **A one-sided epoch is ignored, not read as zero.** 462,833 Debian advisory
 * version strings carry an epoch; SBOM component versions routinely omit it.
 * Reading the missing side as `0` — which is what dpkg itself does, and what
 * Red Hat's own guidance says to do — makes `1.2.3-4` compare as older than
 * `1:1.2.3-1`, so every advisory for an epoch-bearing package reads as "not
 * yet introduced". Dropping the epoch instead assumes the two sides share one,
 * which is the best available inference: an absent epoch is missing
 * information, not a value.
 *
 * **A one-sided revision is ignored.** Same reasoning, one level down. This
 * fires rarely for deb (both sides almost always carry a revision) and is kept
 * mainly so `dpkg` and `rpm` — where it fires constantly — behave alike.
 */

import { isDigit, sign, toBigInt, type Ordering } from "./shared.js";
import type { Comparison } from "./types.js";

export interface DpkgVersion {
    epoch: bigint;
    hasEpoch: boolean;
    upstream: string;
    revision: string;
    hasRevision: boolean;
}

/** Leading run of digits, and the rest. Absent digits read as 0. */
function splitDigitPrefix(str: string): [bigint, string] {
    let i = 0;
    while (i < str.length && isDigit(str[i])) i++;
    if (i === 0) return [0n, str];
    return [BigInt(str.slice(0, i)), str.slice(i)];
}

/** Leading run of non-digits, and the rest. */
function splitNonDigitPrefix(str: string): [string, string] {
    let i = 0;
    while (i < str.length && !isDigit(str[i])) i++;
    return [str.slice(0, i), str.slice(i)];
}

/**
 * dpkg's character collation: `~` sorts before everything including
 * end-of-string, then end-of-string, then letters, then everything else.
 */
function weighChar(char: string): number {
    if (char === "~") return 1;
    if (char === "") return 2;

    const c = char.charCodeAt(0);
    // Push all non-letters above the letters.
    if (c < 65 || (c > 90 && c < 97) || c > 122) return c + 122;
    return c;
}

/** Compare one upstream or revision segment, alternating non-digit and digit runs. */
function compareSegments(a: string, b: string): Ordering {
    while (a !== "" || b !== "") {
        let ap: string;
        let bp: string;
        [ap, a] = splitNonDigitPrefix(a);
        [bp, b] = splitNonDigitPrefix(b);

        if (ap !== bp) {
            const len = Math.max(ap.length, bp.length);
            for (let i = 0; i < len; i++) {
                const aw = weighChar(ap[i] ?? "");
                const bw = weighChar(bp[i] ?? "");
                if (aw !== bw) return aw < bw ? -1 : 1;
            }
        }

        let adp: bigint;
        let bdp: bigint;
        [adp, a] = splitDigitPrefix(a);
        [bdp, b] = splitDigitPrefix(b);

        const diff = sign(adp - bdp);
        if (diff !== 0) return diff;
    }

    return 0;
}

export function parseDpkgVersion(str: string): DpkgVersion {
    str = str.trim();

    let epoch = 0n;
    let hasEpoch = false;

    const colon = str.indexOf(":");
    if (colon !== -1) {
        const parsed = toBigInt(str.slice(0, colon));
        // A non-numeric prefix is not an epoch; leave the string alone rather
        // than rejecting the version outright.
        if (parsed !== null) {
            epoch = parsed;
            hasEpoch = true;
            str = str.slice(colon + 1);
        }
    }

    const dash = str.lastIndexOf("-");
    if (dash !== -1) {
        return {
            epoch,
            hasEpoch,
            upstream: str.slice(0, dash),
            revision: str.slice(dash + 1),
            hasRevision: true,
        };
    }

    return { epoch, hasEpoch, upstream: str, revision: "0", hasRevision: false };
}

/**
 * The character set Debian policy allows: an optional numeric epoch, then an
 * alphanumeric-led run of alphanumerics and `.+-~:`.
 *
 * The comparator itself accepts anything — the segment walk has no notion of
 * invalid input — so without this check it would report `exact` for two
 * strings that are plainly not deb versions, and the confidence flag would
 * mean nothing for this scheme.
 */
const WELL_FORMED = /^(\d+:)?[A-Za-z0-9][A-Za-z0-9.+~:-]*$/;

export function compareDpkg(a: string, b: string, strict = false): Comparison {
    const va = parseDpkgVersion(a);
    const vb = parseDpkgVersion(b);

    const confidence = WELL_FORMED.test(a.trim()) && WELL_FORMED.test(b.trim())
        ? "exact"
        : "fuzzy";

    if (strict || (va.hasEpoch && vb.hasEpoch)) {
        const diff = sign(va.epoch - vb.epoch);
        if (diff !== 0) return { cmp: diff, confidence };
    }

    const upstream = compareSegments(va.upstream, vb.upstream);
    if (upstream !== 0) return { cmp: upstream, confidence };

    if (strict || (va.hasRevision && vb.hasRevision)) {
        return { cmp: compareSegments(va.revision, vb.revision), confidence };
    }

    return { cmp: 0, confidence };
}

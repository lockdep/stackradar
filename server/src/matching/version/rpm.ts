/**
 * rpm version ordering — Red Hat, Rocky, Alma, CentOS, Oracle, SUSE, Mageia,
 * Photon.
 *
 * Format `[epoch:]version[-release]`, each component ordered by `rpmvercmp(8)`.
 * See https://docs.fedoraproject.org/en-US/packaging-guidelines/Versioning/
 *
 * Ported from osv-scalibr `semantic/version-redhat.go`, which follows the
 * rpmvercmp algorithm step for step; the numbered comments below are those
 * steps.
 *
 * ## Two deliberate divergences from native rpm
 *
 * Both apply only when `strict` is off, which is how the matcher always calls
 * this. They matter more here than anywhere else in this directory: **every
 * one of the 587,728 Red Hat advisory version strings carries an epoch**, and
 * SBOM rpm versions essentially never do.
 *
 * **A one-sided epoch is ignored, not read as zero.** Red Hat's own guidance
 * is that an unspecified epoch is zero, and that is right for a package that
 * has never used one. It is wrong here: the advisory states `2:3.1.6-7.el3`
 * precisely because this package *does* have a non-zero epoch, and the scanner
 * simply did not record it. Reading the absent side as `0` would put the
 * component below every bound in the advisory, so nothing would ever match.
 * Dropping the epoch assumes both sides share one — an assumption, but the
 * only one that survives contact with the data. See grype
 * `matcher/rpm/matcher.go:171-210` for the `perl-Errno` false positive that
 * the opposite choice produces.
 *
 * **A one-sided release is ignored.** An advisory written against `1.2.3` with
 * no release applies to every release of `1.2.3`, and a component recorded as
 * `1.2.3` with no release should not be forced below `1.2.3-1`.
 *
 * Note that both divergences leave the result `exact`. They are not guesses
 * about *ordering* — the rpm algorithm still does all the work — they are a
 * rule about which fields carry information. Flagging them `fuzzy` would mark
 * the entire RPM family low-confidence, which is the opposite of what fixing
 * this was for.
 */

import { compareStrings, isAlpha, isDigit, type Ordering } from "./shared.js";
import type { Comparison } from "./types.js";

export interface RpmVersion {
    epoch: string;
    hasEpoch: boolean;
    version: string;
    /** Carries its leading `-` when present, as upstream does. */
    release: string;
    hasRelease: boolean;
}

/** Anything that is not alphanumeric, `~` or `^` is a separator. */
function shouldBeTrimmed(c: string): boolean {
    return !isAlpha(c) && !isDigit(c) && c !== "~" && c !== "^";
}

/** rpmvercmp, applied to a single epoch, version or release component. */
export function compareRpmComponents(a: string, b: string): Ordering {
    if (a === "" && b !== "") return -1;
    if (a !== "" && b === "") return 1;

    let ai = 0;
    let bi = 0;

    for (;;) {
        // 1. Trim leading separators from both.
        while (ai < a.length && shouldBeTrimmed(a[ai]!)) ai++;
        while (bi < b.length && shouldBeTrimmed(b[bi]!)) bi++;

        // 2/3. `~` sorts before everything, including end-of-string.
        const aTilde = ai < a.length && a[ai] === "~";
        const bTilde = bi < b.length && b[bi] === "~";
        if (aTilde && bTilde) {
            ai++;
            bi++;
            continue;
        }
        if (aTilde) return -1;
        if (bTilde) return 1;

        // 4/5. `^` sorts after its base version but before a following release.
        const aCaret = ai < a.length && a[ai] === "^";
        const bCaret = bi < b.length && b[bi] === "^";
        if (aCaret && bCaret) {
            ai++;
            bi++;
            continue;
        }
        if (aCaret) return bi === b.length ? 1 : -1;
        if (bCaret) return ai === a.length ? -1 : 1;

        // 6. Stop once either side is exhausted.
        if (ai === a.length || bi === b.length) break;

        // 7. Pop the leading run of digits, or of letters, from both.
        const numeric = isDigit(a[ai]);
        const inRun = numeric ? isDigit : isAlpha;

        const aStart = ai;
        const bStart = bi;
        while (ai < a.length && inRun(a[ai])) ai++;
        while (bi < b.length && inRun(b[bi])) bi++;

        // 8. An empty run on the b side settles it: digits outrank letters.
        if (bStart === bi) return numeric ? 1 : -1;

        let as = a.slice(aStart, ai);
        let bs = b.slice(bStart, bi);

        // 9. Numeric runs: drop leading zeros, then the longer one wins.
        if (numeric) {
            as = as.replace(/^0+/, "");
            bs = bs.replace(/^0+/, "");
            if (as.length !== bs.length) return as.length > bs.length ? 1 : -1;
        }

        // 10. Same length (or alphabetic): plain string comparison.
        const diff = compareStrings(as, bs);
        if (diff !== 0) return diff;
    }

    // Both ran to the end together, or one has characters left — longest wins.
    const al = a.length - ai;
    const bl = b.length - bi;
    if (al > bl) return 1;
    if (al < bl) return -1;
    return 0;
}

const ONLY_DIGITS = /^\d+$/;

export function parseRpmVersion(str: string): RpmVersion {
    let epoch = "";
    let hasEpoch = false;
    let vr = str;

    const colon = str.indexOf(":");
    if (colon !== -1) {
        const head = str.slice(0, colon);
        // Only a purely numeric prefix is an epoch; anything else is part of
        // the version.
        if (ONLY_DIGITS.test(head)) {
            epoch = head;
            hasEpoch = true;
            vr = str.slice(colon + 1);
        }
    }

    const dash = vr.indexOf("-");
    if (dash !== -1) {
        return {
            epoch: hasEpoch ? epoch : "0",
            hasEpoch,
            version: vr.slice(0, dash),
            // Upstream keeps the `-` so an absent release compares as shorter.
            release: vr.slice(dash),
            hasRelease: true,
        };
    }

    return {
        epoch: hasEpoch ? epoch : "0",
        hasEpoch,
        version: vr,
        release: "",
        hasRelease: false,
    };
}

/**
 * `[epoch:]version[-release]` where version and release are alphanumerics plus
 * `._+~^` and may not contain `-`.
 *
 * rpmvercmp accepts any string — it simply skips characters it does not
 * recognise — so without this check the comparator would report `exact` for
 * two strings that are plainly not rpm versions, and the confidence flag would
 * mean nothing for this scheme.
 */
const WELL_FORMED = /^(\d+:)?[A-Za-z0-9][A-Za-z0-9._+~^]*(-[A-Za-z0-9._+~^]+)?$/;

/**
 * Order two rpm versions. `strict` compares epoch and release even when
 * only one side carries them (the missing side reads as `0` / empty, as
 * native rpm does); off, a one-sided epoch or release is ignored. The
 * matcher only ever calls through `compare()`, which leaves `strict` false.
 */
export function compareRpm(a: string, b: string, strict = false): Comparison {
    const va = parseRpmVersion(a);
    const vb = parseRpmVersion(b);

    const confidence = WELL_FORMED.test(a.trim()) && WELL_FORMED.test(b.trim()) ? "exact" : "fuzzy";

    if (strict || (va.hasEpoch && vb.hasEpoch)) {
        const diff = compareRpmComponents(va.epoch, vb.epoch);
        if (diff !== 0) return { cmp: diff, confidence };
    }

    const version = compareRpmComponents(va.version, vb.version);
    if (version !== 0) return { cmp: version, confidence };

    if (strict || (va.hasRelease && vb.hasRelease)) {
        return { cmp: compareRpmComponents(va.release, vb.release), confidence };
    }

    return { cmp: 0, confidence };
}

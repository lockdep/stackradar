/**
 * apk version ordering — Alpine, Wolfi, Chainguard, MinimOS.
 *
 * Grammar: `number{.number}...{letter}{_suffix{number}}...{~hash}{-r number}`
 * See https://github.com/alpinelinux/apk-tools/blob/master/doc/apk-package.5.scd
 *
 * Ported from osv-scalibr `semantic/version-alpine.go`, which is what the
 * vendored `alpine-versions*.txt` corpora were generated against.
 *
 * Two behaviours are worth knowing before changing anything here:
 *
 *  - A component with a leading zero compares as a *string*, not a number, for
 *    every component after the first. apk does this so `1.01` and `1.1` are
 *    distinct versions rather than the same one written twice.
 *  - The `~hash` commit component is parsed and then ignored. Two builds from
 *    different commits are not orderable, and comparing hex digits lexically
 *    would invent an order that does not exist.
 */

import { compareStrings, sign, type Ordering } from "./shared.js";
import type { Comparison } from "./types.js";

/**
 * Suffix precedence. An absent suffix ranks between the prerelease suffixes and
 * the post-release ones, which is why `RELEASE_RANK` sits in the middle rather
 * than at either end.
 */
const SUFFIX_ORDER = ["alpha", "beta", "pre", "rc", "", "cvs", "svn", "git", "hg"] as const;
const RELEASE_RANK = 4;
/** `p` is the highest-ranked suffix; the parser only ever captures valid ones. */
const P_RANK = SUFFIX_ORDER.length;

function weighSuffix(suffix: string): number {
    const i = SUFFIX_ORDER.indexOf(suffix as (typeof SUFFIX_ORDER)[number]);
    return i === -1 ? P_RANK : i;
}

const NUMBER_COMPONENTS = /^(?:\d+\.?)*/;
const FIRST_CHAR_LOWERCASE_LETTER = /^[a-z]/;
const SUFFIXES = /_(alpha|beta|pre|rc|cvs|svn|git|hg|p)(\d*)/g;
const HASH = /^~[0-9a-f]+/;
const BUILD_COMPONENT = /^-r(\d*)/;
/** A leading `v`/`V` immediately followed by a digit is a display prefix. */
const LEADING_V = /^[vV](?=\d)/;

interface NumberComponent {
    original: string;
    value: bigint;
    index: number;
}

interface Suffix {
    weight: number;
    number: bigint;
}

export interface ApkVersion {
    original: string;
    /** True when parsing left a tail that is not a valid build component. */
    invalid: boolean;
    /** Whatever could not be parsed, kept because its presence affects order. */
    remainder: string;
    components: NumberComponent[];
    letter: string;
    suffixes: Suffix[];
    hash: string;
    buildComponent: bigint;
}

function compareNumberComponents(a: NumberComponent, b: NumberComponent): Ordering {
    // Leading zeros make a component a string, but only past the first one:
    // `01.1` is still version 1, whereas `1.01` is not `1.1`.
    if (a.index !== 0 && b.index !== 0) {
        if (a.original.startsWith("0") || b.original.startsWith("0")) {
            return compareStrings(a.original, b.original);
        }
    }
    return sign(a.value - b.value);
}

const ZERO_COMPONENT: NumberComponent = { original: "0", value: 0n, index: 0 };
const ABSENT_SUFFIX: Suffix = { weight: RELEASE_RANK, number: 0n };

export function parseApkVersion(str: string): ApkVersion {
    const original = str;
    let rest = str.replace(LEADING_V, "");

    const v: ApkVersion = {
        original,
        invalid: false,
        remainder: "",
        components: [],
        letter: "",
        suffixes: [],
        hash: "",
        buildComponent: 0n,
    };

    // Numbers, first and always: every other parser below assumes they are gone.
    const numbers = NUMBER_COMPONENTS.exec(rest)?.[0] ?? "";
    if (numbers !== "") {
        const parts = numbers.split(".");
        for (let i = 0; i < parts.length; i++) {
            const d = parts[i]!;
            // apk tolerates a dot that is not followed by a digit even though
            // the spec forbids it; the version simply ends there.
            if (d === "") break;
            v.components.push({ original: d, value: BigInt(d), index: i });
        }
        rest = rest.slice(numbers.length);
    }

    // A single lower-case letter, only after the numeric components.
    if (FIRST_CHAR_LOWERCASE_LETTER.test(rest)) {
        v.letter = rest.slice(0, 1);
        rest = rest.slice(1);
    }

    SUFFIXES.lastIndex = 0;
    for (const match of rest.matchAll(SUFFIXES)) {
        v.suffixes.push({
            weight: weighSuffix(match[1]!),
            number: BigInt(match[2] === "" || match[2] === undefined ? "0" : match[2]),
        });
        // Upstream trims each match only when it is a prefix, so a suffix found
        // mid-string is recorded but leaves the remainder alone.
        if (rest.startsWith(match[0])) rest = rest.slice(match[0].length);
    }

    const hash = HASH.exec(rest)?.[0] ?? "";
    if (hash !== "") {
        v.hash = hash;
        rest = rest.slice(hash.length);
    }

    if (rest !== "") {
        const build = BUILD_COMPONENT.exec(rest);
        if (build === null) {
            // This is the last thing a valid version can carry, so anything
            // left over means we are no longer reading an apk version.
            v.invalid = true;
        } else {
            v.buildComponent = BigInt(build[1] === "" ? "0" : build[1]!);
            rest = rest.slice(build[0].length);
        }
    }

    v.remainder = rest;
    return v;
}

function compareComponents(a: ApkVersion, b: ApkVersion): Ordering {
    const len = Math.max(a.components.length, b.components.length);
    for (let i = 0; i < len; i++) {
        const diff = compareNumberComponents(a.components[i] ?? ZERO_COMPONENT, b.components[i] ?? ZERO_COMPONENT);
        if (diff !== 0) return diff;
    }
    return 0;
}

function compareLetters(a: ApkVersion, b: ApkVersion): Ordering {
    // No letter sorts before any letter: `1.1.1` < `1.1.1w`.
    if (a.letter === "" && b.letter !== "") return -1;
    if (a.letter !== "" && b.letter === "") return 1;
    return compareStrings(a.letter, b.letter);
}

function compareSuffixes(a: ApkVersion, b: ApkVersion): Ordering {
    const len = Math.max(a.suffixes.length, b.suffixes.length);
    for (let i = 0; i < len; i++) {
        const x = a.suffixes[i] ?? ABSENT_SUFFIX;
        const y = b.suffixes[i] ?? ABSENT_SUFFIX;
        if (x.weight !== y.weight) return x.weight < y.weight ? -1 : 1;
        const diff = sign(x.number - y.number);
        if (diff !== 0) return diff;
    }
    return 0;
}

export function compareApk(a: string, b: string): Comparison {
    const va = parseApkVersion(a);
    const vb = parseApkVersion(b);

    // Anything we could not fully parse makes the result an inference.
    const confidence = va.invalid || vb.invalid ? "fuzzy" : "exact";

    // Two versions we understood equally badly: fall back to the raw strings,
    // which at least gives a stable order.
    if (va.invalid && vb.invalid) {
        return { cmp: compareStrings(va.original, vb.original), confidence };
    }

    const checks: Array<Ordering> = [
        compareComponents(va, vb),
        compareLetters(va, vb),
        compareSuffixes(va, vb),
        // Commit hashes are deliberately skipped — see the module comment.
        sign(va.buildComponent - vb.buildComponent),
        compareRemainder(va, vb),
    ];

    for (const diff of checks) {
        if (diff !== 0) return { cmp: diff, confidence };
    }

    return { cmp: 0, confidence };
}

/** A version with an unparsed tail ranks below one without. */
function compareRemainder(a: ApkVersion, b: ApkVersion): Ordering {
    if (a.remainder === "" && b.remainder !== "") return 1;
    if (a.remainder !== "" && b.remainder === "") return -1;
    return 0;
}

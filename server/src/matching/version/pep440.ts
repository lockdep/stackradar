/**
 * PEP 440 version ordering — PyPI.
 *
 * https://peps.python.org/pep-0440/
 *
 * Ported from osv-scalibr `semantic/version-pypi.go`.
 *
 * 20.6% of the 1.27M PyPI version strings in the OSV export fail a permissive
 * semver pattern — `0.3.17.dev2`, `2.0a1`, `1.0.0.post1`, `1!2.0` — so this is
 * not an optional refinement. Guessing at those with a semver comparator
 * misorders a fifth of the ecosystem; refusing to compare them loses matches
 * that 77% of PyPI advisories only express as ranges.
 *
 * Anything that does not fit PEP 440 at all is handled by the *legacy* path,
 * a best-effort port of setuptools' pre-PEP-440 ordering. Legacy versions sort
 * below every PEP 440 version and are always reported `fuzzy`.
 */

import { compareComponentLists, compareStrings, sign, toBigInt, type Ordering } from "./shared.js";
import type { Comparison } from "./types.js";

/** From PEP 440 Appendix B, with Go's named groups rewritten for JS. */
const PEP440 =
    /^\s*v?(?:(?:(?<epoch>[0-9]+)!)?(?<release>[0-9]+(?:\.[0-9]+)*)(?<pre>[-_.]?(?<pre_l>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?<pre_n>[0-9]+)?)?(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]+)?))?(?<dev>[-_.]?(?<dev_l>dev)[-_.]?(?<dev_n>[0-9]+)?)?)(?:\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/;

const LOCAL_SEPARATOR = /[._-]/;
const LEGACY_PARTS = /\d+|[a-z]+|\.|-/g;

/**
 * A letter/number pair such as `rc2` or `post1`. `number === null` means the
 * segment is absent — distinct from present-with-value-zero, which is what
 * makes `1.0` and `1.0.post0` different versions.
 */
interface LetterAndNumber {
    letter: string;
    number: bigint | null;
}

const ABSENT: LetterAndNumber = { letter: "", number: null };

export interface Pep440Version {
    epoch: bigint;
    release: bigint[];
    pre: LetterAndNumber;
    post: LetterAndNumber;
    dev: LetterAndNumber;
    local: string[];
    /** Non-empty only for versions that do not fit PEP 440 at all. */
    legacy: string[];
}

function parseLetterVersion(letter: string, number: string): LetterAndNumber {
    if (letter !== "") {
        // A prerelease with no numeral carries an implicit 0.
        const n = number === "" ? "0" : number;
        letter = letter.toLowerCase();

        // Normalize the alternative spellings onto one canonical form.
        switch (letter) {
            case "alpha":
                letter = "a";
                break;
            case "beta":
                letter = "b";
                break;
            case "c":
            case "pre":
            case "preview":
                letter = "rc";
                break;
            case "rev":
            case "r":
                letter = "post";
                break;
        }

        return { letter, number: BigInt(n) };
    }

    if (number !== "") {
        // A number with no letter is the implicit post-release form, `1.0-1`.
        return { letter: "post", number: BigInt(number) };
    }

    return ABSENT;
}

function normalizeLegacyPart(part: string): string {
    switch (part) {
        case "pre":
        case "preview":
        case "rc":
            part = "c";
            break;
        case "-":
            part = "final-";
            break;
        case "dev":
            part = "@";
            break;
    }

    // Zero-pad numbers so the join-and-strcmp below orders them numerically.
    if (part[0]! >= "0" && part[0]! <= "9") return part.padStart(8, "0");
    return `*${part}`;
}

function parseLegacyParts(str: string): string[] {
    const parts: string[] = [];
    const splits = [...(str.match(LEGACY_PARTS) ?? []), "final"];

    for (const raw of splits) {
        if (raw === "" || raw === ".") continue;

        const part = normalizeLegacyPart(raw);

        if (part.startsWith("*")) {
            if (compareStrings(part, "*final") < 0) {
                while (parts.length > 0 && parts[parts.length - 1] === "*final-") parts.pop();
            }
            while (parts.length > 0 && parts[parts.length - 1] === "00000000") parts.pop();
        }

        parts.push(part);
    }

    return parts;
}

export function parsePep440Version(str: string): Pep440Version {
    str = str.toLowerCase();

    const match = PEP440.exec(str);
    if (match === null) {
        return {
            // Legacy versions sort below every PEP 440 version; the epoch here
            // is never consulted because compareLegacy settles it first.
            epoch: -1n,
            release: [],
            pre: ABSENT,
            post: ABSENT,
            dev: ABSENT,
            local: [],
            legacy: parseLegacyParts(str),
        };
    }

    const g = match.groups!;

    const post = g["post_n1"] !== undefined && g["post_n1"] !== "" ? g["post_n1"] : (g["post_n2"] ?? "");

    return {
        epoch: g["epoch"] ? BigInt(g["epoch"]) : 0n,
        release: g["release"]!.split(".").map((r) => BigInt(r)),
        pre: parseLetterVersion(g["pre_l"] ?? "", g["pre_n"] ?? ""),
        post: parseLetterVersion(g["post_l"] ?? "", post),
        dev: parseLetterVersion(g["dev_l"] ?? "", g["dev_n"] ?? ""),
        local: g["local"] ? g["local"].split(LOCAL_SEPARATOR).map((p) => p.toLowerCase()) : [],
        legacy: [],
    };
}

/**
 * `1.0.dev0` must sort below `1.0a0`, which the field-by-field comparison below
 * would otherwise get backwards: a dev release with no pre-release segment is
 * older than any pre-release of the same version.
 */
function shouldApplyPreTrick(v: Pep440Version): boolean {
    return v.pre.number === null && v.post.number === null && v.dev.number !== null;
}

function comparePre(a: Pep440Version, b: Pep440Version): Ordering {
    const at = shouldApplyPreTrick(a);
    const bt = shouldApplyPreTrick(b);
    if (at && bt) return 0;
    if (at) return -1;
    if (bt) return 1;

    // A version without a prerelease sorts after one with it.
    if (a.pre.number === null && b.pre.number === null) return 0;
    if (a.pre.number === null) return 1;
    if (b.pre.number === null) return -1;

    const diff = compareStrings(a.pre.letter[0]!, b.pre.letter[0]!);
    if (diff !== 0) return diff;
    return sign(a.pre.number - b.pre.number);
}

/** A version without a post segment sorts before one with it. */
function comparePost(a: Pep440Version, b: Pep440Version): Ordering {
    if (a.post.number === null && b.post.number === null) return 0;
    if (a.post.number === null) return -1;
    if (b.post.number === null) return 1;
    return sign(a.post.number - b.post.number);
}

/** A version without a dev segment sorts after one with it. */
function compareDev(a: Pep440Version, b: Pep440Version): Ordering {
    if (a.dev.number === null && b.dev.number === null) return 0;
    if (a.dev.number === null) return 1;
    if (b.dev.number === null) return -1;
    return sign(a.dev.number - b.dev.number);
}

function compareLocal(a: Pep440Version, b: Pep440Version): Ordering {
    const min = Math.min(a.local.length, b.local.length);

    for (let i = 0; i < min; i++) {
        const ai = toBigInt(a.local[i]!);
        const bi = toBigInt(b.local[i]!);

        let compare: Ordering;
        if (ai !== null && bi !== null) {
            compare = sign(ai - bi);
        } else if (ai === null && bi === null) {
            compare = compareStrings(a.local[i]!, b.local[i]!);
        } else if (ai !== null) {
            // A numeric segment always outranks a lexical one.
            compare = 1;
        } else {
            compare = -1;
        }

        if (compare !== 0) return compare;
    }

    // More segments wins, provided the shorter one is a prefix of the longer.
    return sign(a.local.length - b.local.length);
}

function compareLegacy(a: Pep440Version, b: Pep440Version): Ordering {
    if (a.legacy.length === 0 && b.legacy.length === 0) return 0;
    if (a.legacy.length === 0) return 1;
    if (b.legacy.length === 0) return -1;
    return compareStrings(a.legacy.join(""), b.legacy.join(""));
}

export function comparePep440(a: string, b: string): Comparison {
    const va = parsePep440Version(a);
    const vb = parsePep440Version(b);

    const confidence = va.legacy.length > 0 || vb.legacy.length > 0 ? "fuzzy" : "exact";

    const checks: Ordering[] = [
        compareLegacy(va, vb),
        sign(va.epoch - vb.epoch),
        compareComponentLists(va.release, vb.release),
        comparePre(va, vb),
        comparePost(va, vb),
        compareDev(va, vb),
        compareLocal(va, vb),
    ];

    for (const diff of checks) {
        if (diff !== 0) return { cmp: diff, confidence };
    }

    return { cmp: 0, confidence };
}

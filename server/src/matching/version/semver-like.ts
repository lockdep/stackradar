/**
 * "Semver-like" parsing: an unlimited run of dot-separated numeric components,
 * an optional leading `v`, and everything after the first non-numeric character
 * treated as a build/prerelease tail.
 *
 * Both `semver.ts` and `nuget.ts` are this parser plus a component cap (3 and 4
 * respectively) and a tail comparator. Ported from osv-scalibr
 * `semantic/version-semver-like.go` and `semantic/version-semver.go`.
 */

import { compareStrings, sign, toBigInt, type Ordering } from "./shared.js";

export interface SemverLikeVersion {
    leadingV: boolean;
    components: bigint[];
    /** Everything after the numeric components, including the leading `-`/`+`. */
    build: string;
    original: string;
}

function parseSemverLike(line: string): SemverLikeVersion {
    const original = line;
    const leadingV = line.startsWith("v");
    if (leadingV) line = line.slice(1);

    const components: bigint[] = [];
    let current = "";
    let foundBuild = false;

    for (const c of line) {
        if (foundBuild) {
            current += c;
            continue;
        }

        if (c >= "0" && c <= "9") {
            current += c;
            continue;
        }

        // Not a digit, and we are still reading components: whatever we have
        // accumulated is a finished component.
        if (current !== "") {
            components.push(BigInt(current));
            current = "";
        }

        // A `.` may be followed by another component; anything else starts the
        // build string.
        if (c === ".") continue;

        foundBuild = true;
        current = c;
    }

    if (!foundBuild && current !== "") {
        components.push(BigInt(current));
        current = "";
    }

    return { leadingV, components, build: current, original };
}

/**
 * Parse, then fold any components beyond `maxComponents` into the build string.
 * A NuGet `1.2.3.4.5` keeps four components and carries `.5` into the tail.
 */
export function parseSemverLikeVersion(line: string, maxComponents: number): SemverLikeVersion {
    const v = parseSemverLike(line);

    if (maxComponents === -1 || v.components.length <= maxComponents) return v;

    const extra = v.components.slice(maxComponents);
    return {
        ...v,
        components: v.components.slice(0, maxComponents),
        build: v.build + extra.map((c) => `.${c}`).join(""),
    };
}

/** Drop semver build metadata — everything from the first `+`. */
function removeBuildMetadata(str: string): string {
    const plus = str.indexOf("+");
    return plus === -1 ? str : str.slice(0, plus);
}

function compareIdentifiers(a: string[], b: string[]): Ordering {
    const min = Math.min(a.length, b.length);

    for (let i = 0; i < min; i++) {
        const ai = toBigInt(a[i]!);
        const bi = toBigInt(b[i]!);

        let compare: Ordering;
        if (ai !== null && bi !== null) {
            // Identifiers consisting of only digits are compared numerically.
            compare = sign(ai - bi);
        } else if (ai === null && bi === null) {
            // Identifiers with letters or hyphens compare lexically, ASCII order.
            compare = compareStrings(a[i]!, b[i]!);
        } else if (ai !== null) {
            // Numeric identifiers have lower precedence than non-numeric ones.
            compare = -1;
        } else {
            compare = 1;
        }

        if (compare !== 0) return compare;
    }

    // A larger set of prerelease fields outranks a smaller one when all the
    // preceding identifiers are equal.
    return sign(a.length - b.length);
}

/**
 * Compare two build/prerelease tails under semver's precedence rules.
 * Exported because NuGet uses the same tail comparison, lowercased.
 */
export function compareBuildComponents(a: string, b: string): Ordering {
    a = removeBuildMetadata(a);
    b = removeBuildMetadata(b);

    // The spec does not say the hyphen is excluded from the compare, but that
    // is what node-semver does and what the corpora were generated against.
    if (a.startsWith("-")) a = a.slice(1);
    if (b.startsWith("-")) b = b.slice(1);

    // A version with a prerelease ranks below the same version without one.
    if (a === "" && b !== "") return 1;
    if (a !== "" && b === "") return -1;

    return compareIdentifiers(a.split("."), b.split("."));
}

/**
 * Reader for the vendored osv-scalibr conformance corpora.
 *
 * See `tests/fixtures/version-conformance/README.md` for provenance and format.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scheme } from "../../../../src/matching/version/index.js";

const FIXTURE_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../fixtures/version-conformance"
);

export type Operator = "<" | "=" | ">";

export interface Assertion {
    a: string;
    op: Operator;
    b: string;
    /** Expected `cmp` value for `a` compared to `b`. */
    expected: -1 | 0 | 1;
    /** 1-indexed line in the source file, for failure messages. */
    line: number;
    file: string;
}

/** Which corpus files exercise which scheme. */
export const CORPORA: ReadonlyArray<{ scheme: Scheme; files: readonly string[] }> = [
    { scheme: "apk", files: ["alpine-versions.txt", "alpine-versions-generated.txt"] },
    { scheme: "dpkg", files: ["debian-versions.txt", "debian-versions-generated.txt"] },
    { scheme: "rpm", files: ["redhat-versions.txt"] },
    { scheme: "pep440", files: ["pypi-versions.txt", "pypi-versions-generated.txt"] },
    { scheme: "maven", files: ["maven-versions.txt", "maven-versions-generated.txt"] },
    { scheme: "gem", files: ["rubygems-versions.txt", "rubygems-versions-generated.txt"] },
    { scheme: "nuget", files: ["nuget-versions.txt"] },
    { scheme: "composer", files: ["packagist-versions.txt", "packagist-versions-generated.txt"] },
    { scheme: "semver", files: ["semver-versions.txt"] },
];

const EXPECTED: Record<Operator, -1 | 0 | 1> = { "<": -1, "=": 0, ">": 1 };

/**
 * Parse one corpus file into assertions.
 *
 * The comment prefixes carry a trailing space on purpose — that is upstream's
 * rule, and without it a line like `#4 < #5` would be dropped instead of
 * asserted.
 */
export function readCorpus(file: string): Assertion[] {
    const content = readFileSync(join(FIXTURE_DIR, file), "utf8");
    const assertions: Assertion[] = [];

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line === "" || line.startsWith("# ") || line.startsWith("// ")) continue;

        const pieces = line.split(" ");
        if (pieces.length !== 3) {
            throw new Error(`${file}:${i + 1}: expected 3 space-separated pieces, got "${line}"`);
        }

        const [a, op, b] = pieces as [string, string, string];
        const expected = EXPECTED[op as Operator];
        if (expected === undefined) {
            throw new Error(`${file}:${i + 1}: unknown operator "${op}"`);
        }

        assertions.push({ a, op: op as Operator, b, expected, line: i + 1, file });
    }

    return assertions;
}

/** Every corpus file present on disk, whether or not `CORPORA` references it. */
export function corpusFiles(): string[] {
    return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".txt"));
}

/** The exact text of an assertion, as it appears in the corpus. */
export function assertionKey(assertion: Pick<Assertion, "a" | "op" | "b">): string {
    return `${assertion.a} ${assertion.op} ${assertion.b}`;
}

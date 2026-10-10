/**
 * Conformance: every comparator against the version orderings the real package
 * managers produce.
 *
 * ~71,600 assertions vendored from osv-scalibr (see
 * `tests/fixtures/version-conformance/README.md`). Assertions are batched one
 * `it()` per corpus file and reported as a list of failures, because 71,600
 * individual test cases would drown the reporter and tell you nothing a list
 * of failing lines does not.
 *
 * Two passes:
 *
 *  1. **Native semantics** (`strict: true`) — must be perfect. This is the
 *     proof that the algorithms are right.
 *  2. **Matching semantics** — the path the matcher actually takes. Must fail
 *     exactly the assertions in `exclusions.ts` and no others, which is the
 *     proof that the OSV leniencies are narrow.
 */

import { describe, expect, it } from "vitest";
import { compare } from "../../../../src/matching/version/index.js";
import { assertionKey, CORPORA, corpusFiles, readCorpus } from "./corpus.js";
import { CONFORMANCE_EXCLUSIONS, exclusionsFor } from "./exclusions.js";
import type { Scheme } from "../../../../src/matching/version/index.js";

/** Run one corpus file, returning the assertions whose ordering we got wrong. */
function failures(file: string, scheme: Scheme, strict: boolean): string[] {
    const out: string[] = [];

    for (const assertion of readCorpus(file)) {
        const result = compare(assertion.a, assertion.b, scheme, { strict });
        const actual = result === null ? "null" : result.cmp;

        if (actual !== assertion.expected) {
            out.push(`${file}:${assertion.line}  ${assertionKey(assertion)}  → got ${actual}`);
        }
    }

    return out;
}

describe("version conformance", () => {
    describe("native semantics", () => {
        for (const { scheme, files } of CORPORA) {
            for (const file of files) {
                it(`${scheme}: ${file}`, () => {
                    expect(failures(file, scheme, true)).toEqual([]);
                });
            }
        }

        it("covers every corpus file that was vendored", () => {
            // A file copied into the fixture directory but left out of CORPORA
            // would silently never run — the worst kind of missing coverage,
            // because the directory listing makes it look covered.
            const referenced = new Set(CORPORA.flatMap((c) => c.files));
            expect([...corpusFiles()].sort()).toEqual([...referenced].sort());
        });
    });

    describe("matching semantics", () => {
        for (const { scheme, files } of CORPORA) {
            for (const file of files) {
                it(`${scheme}: ${file} diverges only where documented`, () => {
                    const excluded = exclusionsFor(file);
                    const observed = failures(file, scheme, false);

                    // Reduce failures to their assertion text so the set can be
                    // compared against the exclusions regardless of line number.
                    const observedText = new Set(
                        observed.map((f) => f.split("  ")[1]!)
                    );

                    expect([...observedText].sort()).toEqual([...excluded].sort());
                });
            }
        }
    });

    it("has no stale exclusions", () => {
        // Every excluded assertion must still be present in its corpus. An
        // exclusion naming a line upstream has since deleted would otherwise
        // sit here forever looking like a known issue.
        for (const exclusion of CONFORMANCE_EXCLUSIONS) {
            const present = readCorpus(exclusion.file).some(
                (a) => assertionKey(a) === exclusion.assertion
            );
            expect(present, `${exclusion.file}: "${exclusion.assertion}" not found`).toBe(true);
        }
    });

    it("documents a reason for every exclusion", () => {
        for (const exclusion of CONFORMANCE_EXCLUSIONS) {
            expect(exclusion.reason.length).toBeGreaterThan(20);
        }
    });
});

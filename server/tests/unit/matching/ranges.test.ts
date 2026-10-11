/**
 * Range evaluation: does this version fall inside what the advisory states?
 *
 * The cases that matter most are the ones about *not* answering. A comparator
 * that cannot order a bound must produce `null`, and `null` must survive to the
 * caller — every alternative turns an unreadable advisory into a confident
 * claim in one direction or the other.
 *
 * Rows 5, 6, 9, 12 and 19 of the plan's regression corpus live here.
 */

import { describe, expect, it } from "vitest";

import type { OsvRange, OsvRangeEvent } from "../../../src/db/schema/vulnerabilities.js";
import { evaluateAffected, isUnknownVersion } from "../../../src/matching/ranges.js";
import type { AffectedEntry } from "../../../src/matching/ranges.js";

function entry(partial: Partial<AffectedEntry>): AffectedEntry {
    return { ecosystem: null, versions: null, ranges: null, ...partial };
}

function ecosystemRange(...events: OsvRangeEvent[]): OsvRange {
    return { type: "ECOSYSTEM", events };
}

function semverRange(...events: OsvRangeEvent[]): OsvRange {
    return { type: "SEMVER", events };
}

describe("isUnknownVersion()", () => {
    it("treats absent, blank and the literal 'unknown' alike", () => {
        expect(isUnknownVersion(null)).toBe(true);
        expect(isUnknownVersion(undefined)).toBe(true);
        expect(isUnknownVersion("")).toBe(true);
        expect(isUnknownVersion("   ")).toBe(true);
        expect(isUnknownVersion("unknown")).toBe(true);
        expect(isUnknownVersion("UNKNOWN")).toBe(true);
        expect(isUnknownVersion("Unknown")).toBe(true);
    });

    it("treats Go's development-build sentinel the same way", () => {
        // A binary built outside a module names no release, so it cannot be
        // ordered against one — see `version/golang.ts`.
        expect(isUnknownVersion("(devel)")).toBe(true);
        expect(isUnknownVersion("  (devel)  ")).toBe(true);
    });

    it("does not swallow real versions", () => {
        expect(isUnknownVersion("0")).toBe(false);
        expect(isUnknownVersion("1.0.0")).toBe(false);
        expect(isUnknownVersion("unknown-1.0")).toBe(false);
        expect(isUnknownVersion("devel")).toBe(false);
    });
});

describe("evaluateAffected() — the explicit versions list", () => {
    it("confirms a listed version exactly", () => {
        const result = evaluateAffected("1.0.1", entry({ ecosystem: "PyPI", versions: ["1.0.0", "1.0.1"] }), "pep440");

        expect(result).toEqual({ affected: true, confidence: "exact" });
    });

    it("confirms a *negative* when the list is the only evidence", () => {
        const result = evaluateAffected("2.0.0", entry({ ecosystem: "PyPI", versions: ["1.0.0", "1.0.1"] }), "pep440");

        expect(result).toEqual({ affected: false, confidence: "exact" });
    });

    it("falls through to the ranges when the version is not listed", () => {
        const result = evaluateAffected(
            "1.5.0",
            entry({
                ecosystem: "PyPI",
                versions: ["1.0.0"],
                ranges: [ecosystemRange({ introduced: "1.4.0" }, { fixed: "2.0.0" })],
            }),
            "pep440",
        );

        expect(result).toEqual({ affected: true, confidence: "exact" });
    });
});

describe("evaluateAffected() — interval semantics", () => {
    const range = entry({
        ecosystem: "npm",
        ranges: [semverRange({ introduced: "1.0.0" }, { fixed: "1.2.0" })],
    });

    it("is half-open: introduced is inclusive, fixed is not", () => {
        expect(evaluateAffected("0.9.0", range, "semver")?.affected).toBe(false);
        expect(evaluateAffected("1.0.0", range, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.1.9", range, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.2.0", range, "semver")?.affected).toBe(false);
        expect(evaluateAffected("2.0.0", range, "semver")?.affected).toBe(false);
    });

    it("treats introduced: '0' as everything from the beginning", () => {
        const fromZero = entry({
            ecosystem: "npm",
            ranges: [semverRange({ introduced: "0" }, { fixed: "1.2.0" })],
        });

        expect(evaluateAffected("0.0.1", fromZero, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.2.0", fromZero, "semver")?.affected).toBe(false);
    });

    it("treats last_affected as inclusive, unlike fixed", () => {
        const lastAffected = entry({
            ecosystem: "npm",
            ranges: [semverRange({ introduced: "1.0.0" }, { last_affected: "1.2.0" })],
        });

        expect(evaluateAffected("1.2.0", lastAffected, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.2.1", lastAffected, "semver")?.affected).toBe(false);
    });

    it("treats limit as an exclusive upper bound", () => {
        const limited = entry({
            ecosystem: "npm",
            ranges: [semverRange({ introduced: "1.0.0" }, { limit: "1.2.0" })],
        });

        expect(evaluateAffected("1.1.0", limited, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.2.0", limited, "semver")?.affected).toBe(false);
    });

    it("handles a vulnerability re-introduced after a fix", () => {
        const reintroduced = entry({
            ecosystem: "npm",
            ranges: [
                semverRange({ introduced: "1.0.0" }, { fixed: "1.2.0" }, { introduced: "1.5.0" }, { fixed: "1.8.0" }),
            ],
        });

        expect(evaluateAffected("1.1.0", reintroduced, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.3.0", reintroduced, "semver")?.affected).toBe(false);
        expect(evaluateAffected("1.6.0", reintroduced, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.9.0", reintroduced, "semver")?.affected).toBe(false);
    });

    it("is affected by any one of several ranges", () => {
        const twoRanges = entry({
            ecosystem: "npm",
            ranges: [
                semverRange({ introduced: "1.0.0" }, { fixed: "1.2.0" }),
                semverRange({ introduced: "2.0.0" }, { fixed: "2.1.0" }),
            ],
        });

        expect(evaluateAffected("2.0.5", twoRanges, "semver")?.affected).toBe(true);
        expect(evaluateAffected("1.5.0", twoRanges, "semver")?.affected).toBe(false);
    });
});

describe("evaluateAffected() — event ordering (corpus row 12)", () => {
    /**
     * Out-of-order events are the case sorting exists for, and the case where
     * an unsorted walk is not merely different but wrong: reading `fixed`
     * before any `introduced` leaves the closing bound unapplied, so every
     * version above the introduction reads as affected forever.
     */
    it("gives the same verdict whichever order the events are written in", () => {
        const documentOrder = entry({
            ecosystem: "npm",
            ranges: [semverRange({ fixed: "1.2.0" }, { introduced: "1.0.0" })],
        });
        const sortedOrder = entry({
            ecosystem: "npm",
            ranges: [semverRange({ introduced: "1.0.0" }, { fixed: "1.2.0" })],
        });

        for (const version of ["0.9.0", "1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
            expect(evaluateAffected(version, documentOrder, "semver"), version).toEqual(
                evaluateAffected(version, sortedOrder, "semver"),
            );
        }

        // Specifically: the version above the fix must come out unaffected.
        expect(evaluateAffected("1.3.0", documentOrder, "semver")?.affected).toBe(false);
    });

    it("opens an interval before closing it when both bounds are the same version", () => {
        const empty = entry({
            ecosystem: "npm",
            ranges: [semverRange({ fixed: "1.2.0" }, { introduced: "1.2.0" })],
        });

        expect(evaluateAffected("1.2.0", empty, "semver")?.affected).toBe(false);
    });
});

describe("evaluateAffected() — the indeterminate case", () => {
    it("returns null rather than guessing when a bound cannot be ordered", () => {
        const unreadable = entry({
            ecosystem: "npm",
            ranges: [semverRange({ introduced: "1.0.0" }, { fixed: "" })],
        });

        expect(evaluateAffected("1.5.0", unreadable, "semver")).toBeNull();
    });

    it("lets a range that does match win over one that could not be read", () => {
        const mixed = entry({
            ecosystem: "npm",
            ranges: [
                semverRange({ introduced: "1.0.0" }, { fixed: "" }),
                semverRange({ introduced: "1.4.0" }, { fixed: "1.6.0" }),
            ],
        });

        expect(evaluateAffected("1.5.0", mixed, "semver")).toEqual({
            affected: true,
            confidence: "exact",
        });
    });

    it("refuses a *negative* when any range was unreadable", () => {
        const mixed = entry({
            ecosystem: "npm",
            ranges: [
                semverRange({ introduced: "1.0.0" }, { fixed: "" }),
                semverRange({ introduced: "1.4.0" }, { fixed: "1.6.0" }),
            ],
        });

        expect(evaluateAffected("9.0.0", mixed, "semver")).toBeNull();
    });

    it("returns null for a component with no usable version (corpus row 9)", () => {
        const range = entry({
            ecosystem: "npm",
            ranges: [semverRange({ introduced: "0" }, { fixed: "1.2.0" })],
        });

        expect(evaluateAffected("unknown", range, "semver")).toBeNull();
        expect(evaluateAffected(null, range, "semver")).toBeNull();
        expect(evaluateAffected("", range, "semver")).toBeNull();
    });

    it("returns null when there is nothing at all to compare against", () => {
        expect(evaluateAffected("1.0.0", entry({ ecosystem: "npm" }), "semver")).toBeNull();
        expect(evaluateAffected("1.0.0", entry({ ecosystem: "npm", ranges: [] }), "semver")).toBeNull();
    });
});

describe("evaluateAffected() — the Go stdlib under SEMVER ranges", () => {
    // Go advisories carry SEMVER ranges, so `semver` is the primary scheme and
    // the component's `golang` scheme the fallback. A GOEXPERIMENT-stamped
    // stdlib version has to reach the fallback: read by `semver` alone it sat
    // below every bound, matching every stdlib advisory since 1.6 and none of
    // the ones for its own release.
    const version = "go1.26.4-X:jsonv2";

    it("is not affected by an ancient advisory fixed long before its release", () => {
        const ancient = entry({
            ecosystem: "Go",
            ranges: [semverRange({ introduced: "0" }, { fixed: "1.12.16" })],
        });

        expect(evaluateAffected(version, ancient, "golang")).toEqual({
            affected: false,
            confidence: "exact",
        });
    });

    it("is affected by an advisory for its own release", () => {
        const current = entry({
            ecosystem: "Go",
            ranges: [semverRange({ introduced: "1.26.0-0" }, { fixed: "1.26.6" })],
        });

        expect(evaluateAffected(version, current, "golang")).toEqual({
            affected: true,
            confidence: "exact",
        });
    });

    it("is indeterminate rather than affected-by-everything with no fallback", () => {
        // No package scheme (an unknown purl type): `semver` cannot order the
        // string and nothing else is asked. Unconfirmed, not a confident hit.
        const ancient = entry({
            ecosystem: "Go",
            ranges: [semverRange({ introduced: "0" }, { fixed: "1.12.16" })],
        });

        expect(evaluateAffected(version, ancient, null)).toBeNull();
    });
});

describe("evaluateAffected() — range type precedence", () => {
    it("prefers SEMVER ranges, which the OSV spec defines as semver-ordered", () => {
        const both = entry({
            ecosystem: "Alpine:v3.23",
            ranges: [
                ecosystemRange({ introduced: "0" }, { fixed: "9.9.9-r0" }),
                semverRange({ introduced: "0" }, { fixed: "1.0.0" }),
            ],
        });

        // Under the ECOSYSTEM range this would be affected; the SEMVER range
        // is the one that applies, and it puts the fix below the component.
        expect(evaluateAffected("2.0.0", both, "apk")?.affected).toBe(false);
    });

    /**
     * osv-scalibr stops at the first non-`ECOSYSTEM` range and discards
     * everything after it. That drops real bounds from entries carrying a GIT
     * range alongside version ranges, so it is deliberately not ported.
     */
    it("does not let a GIT range suppress the ECOSYSTEM ranges after it", () => {
        const withGit = entry({
            ecosystem: "Alpine:v3.23",
            ranges: [
                { type: "GIT", repo: "https://example.invalid/repo", events: [{ introduced: "0" }] },
                ecosystemRange({ introduced: "0" }, { fixed: "8.17.0-r1" }),
            ],
        });

        expect(evaluateAffected("8.16.0-r0", withGit, "apk")?.affected).toBe(true);
        expect(evaluateAffected("8.17.0-r1", withGit, "apk")?.affected).toBe(false);
    });
});

describe("evaluateAffected() — distro schemes and one-sided epochs", () => {
    /**
     * Corpus row 5. Every one of the 587,728 Red Hat advisory version strings
     * carries an epoch and SBOM rpm versions essentially never do, so reading
     * the missing side as `0` would put every component below every bound —
     * the entire RPM family matching nothing.
     */
    it("tolerates a component with no epoch against epoch-bearing rpm bounds", () => {
        const advisory = entry({
            ecosystem: "Red Hat:enterprise_linux:9::appstream",
            ranges: [ecosystemRange({ introduced: "1:1.2.3-1.el9" }, { fixed: "1:1.2.3-5.el9" })],
        });

        expect(evaluateAffected("1.2.3-4.el9", advisory, "rpm")).toEqual({
            affected: true,
            confidence: "exact",
        });
        expect(evaluateAffected("1.2.3-6.el9", advisory, "rpm")?.affected).toBe(false);
    });

    /** Corpus row 6 — the same, for the 462,833 epoch-bearing Debian strings. */
    it("tolerates a component with no epoch against epoch-bearing deb bounds", () => {
        const advisory = entry({
            ecosystem: "Debian:12",
            ranges: [ecosystemRange({ introduced: "1:1.2.3-1" }, { fixed: "1:1.2.3-5" })],
        });

        expect(evaluateAffected("1.2.3-4", advisory, "dpkg")).toEqual({
            affected: true,
            confidence: "exact",
        });
        expect(evaluateAffected("1.2.3-6", advisory, "dpkg")?.affected).toBe(false);
    });

    it("orders apk versions by their -rN revision", () => {
        const advisory = entry({
            ecosystem: "Alpine:v3.23",
            ranges: [ecosystemRange({ introduced: "0" }, { fixed: "8.17.0-r1" })],
        });

        expect(evaluateAffected("8.17.0-r0", advisory, "apk")).toEqual({
            affected: true,
            confidence: "exact",
        });
        expect(evaluateAffected("8.17.0-r1", advisory, "apk")?.affected).toBe(false);
    });
});

describe("evaluateAffected() — confidence", () => {
    /**
     * Corpus row 19. An ecosystem no comparator claims still gets an answer —
     * the fuzzy comparator orders anything — but the answer must never be
     * dressed up as `exact`, because nothing verified the ordering rules.
     */
    it("never reports exact for an ecosystem with no comparator", () => {
        const advisory = entry({
            ecosystem: "SomeFutureEcosystem:2",
            ranges: [ecosystemRange({ introduced: "1.0.0" }, { fixed: "2.0.0" })],
        });

        const result = evaluateAffected("1.5.0", advisory, null);

        expect(result).toEqual({ affected: true, confidence: "fuzzy" });
    });

    it("propagates fuzziness from any comparison that fed the verdict", () => {
        // `not a version!` is outside rpm's grammar, so the comparator orders
        // it but flags the result — and the flag has to reach the caller.
        const advisory = entry({
            ecosystem: "Red Hat:enterprise_linux:9::appstream",
            ranges: [ecosystemRange({ introduced: "0" }, { fixed: "not a version!" })],
        });

        const result = evaluateAffected("1.2.3-4.el9", advisory, "rpm");

        expect(result?.confidence).toBe("fuzzy");
    });

    it("carries fuzziness through a confirmed negative too", () => {
        const advisory = entry({
            ecosystem: "SomeFutureEcosystem:2",
            ranges: [ecosystemRange({ introduced: "1.0.0" }, { fixed: "2.0.0" })],
        });

        expect(evaluateAffected("9.0.0", advisory, null)).toEqual({
            affected: false,
            confidence: "fuzzy",
        });
    });
});

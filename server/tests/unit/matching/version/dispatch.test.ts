/**
 * The `compare()` entry point: scheme dispatch, the empty-version guard, the
 * dual-format retry, and the confidence flag.
 *
 * The conformance corpora prove the comparators order correctly. This file
 * covers everything around them — the parts no corpus can express.
 */

import { describe, expect, it } from "vitest";
import { compare, SCHEMES } from "../../../../src/matching/version/index.js";
import type { Scheme } from "../../../../src/matching/version/index.js";

describe("compare()", () => {
    describe("scheme dispatch", () => {
        it("routes each scheme to a comparator that can order its own dialect", () => {
            // One pair per scheme that only that scheme gets right, so a
            // mis-wired switch case shows up as a wrong answer, not a crash.
            const cases: Array<{ scheme: Scheme; a: string; b: string }> = [
                { scheme: "semver", a: "1.0.0-alpha", b: "1.0.0" },
                { scheme: "golang", a: "go1.24.0", b: "go1.24.1" },
                { scheme: "apk", a: "1.37.0-r9", b: "1.37.0-r10" },
                { scheme: "dpkg", a: "1.0-1", b: "1.0-2" },
                { scheme: "rpm", a: "1.0-1.el8", b: "1.0-2.el8" },
                { scheme: "pep440", a: "1.0.0.dev1", b: "1.0.0" },
                { scheme: "maven", a: "1.0-alpha-1", b: "1.0" },
                { scheme: "gem", a: "4.0.0.beta1", b: "4.0.0" },
                { scheme: "nuget", a: "1.10.0", b: "1.10.0.1" },
                { scheme: "composer", a: "v3.10.0RC1", b: "3.10.0" },
                { scheme: "fuzzy", a: "1.0.2k", b: "1.0.2l" },
            ];

            for (const { scheme, a, b } of cases) {
                expect(compare(a, b, scheme), `${scheme}: ${a} < ${b}`).toMatchObject({ cmp: -1 });
                expect(compare(b, a, scheme), `${scheme}: ${b} > ${a}`).toMatchObject({ cmp: 1 });
            }
        });

        it("is exhaustive over SCHEMES", () => {
            for (const scheme of SCHEMES) {
                expect(compare("1.0.0", "1.0.0", scheme), scheme).not.toBeNull();
            }
        });

        it("is antisymmetric and reflexive for every scheme", () => {
            for (const scheme of SCHEMES) {
                expect(compare("2.1.0", "2.1.0", scheme), scheme).toMatchObject({ cmp: 0 });

                const forward = compare("2.1.0", "1.9.9", scheme);
                const backward = compare("1.9.9", "2.1.0", scheme);
                expect(forward?.cmp, scheme).toBe(1);
                expect(backward?.cmp, scheme).toBe(-1);
            }
        });
    });

    describe("indeterminate results", () => {
        it("returns null when either version is empty", () => {
            expect(compare("", "1.0.0", "semver")).toBeNull();
            expect(compare("1.0.0", "", "semver")).toBeNull();
            expect(compare("", "", "semver")).toBeNull();
        });

        it("returns null for a whitespace-only version", () => {
            expect(compare("   ", "1.0.0", "apk")).toBeNull();
        });

        it("returns null under semver for a version with no numeric component", () => {
            // The whole string parses as a build tail, and a version with no
            // components would sort below every bound — affected by every
            // `introduced: "0"` range, by none for its real release. That is
            // a confident wrong answer, not a fuzzy one.
            expect(compare("abc", "1.0.0", "semver")).toBeNull();
            expect(compare("1.0.0", "abc", "semver")).toBeNull();
            expect(compare("go1.26.4-X:jsonv2", "1.12.16", "semver")).toBeNull();
        });

        it("never coerces an unorderable pair to zero", () => {
            // The single rule this module exists to enforce: `null` must not
            // read as "equal", because "equal" would make a component look
            // like it sits exactly on a fix boundary.
            const result = compare("", "1.0.0", "rpm");
            expect(result).toBeNull();
            expect(result).not.toMatchObject({ cmp: 0 });
        });
    });

    describe("confidence", () => {
        it("reports exact when the scheme parsed both sides", () => {
            expect(compare("1.2.3", "1.2.4", "semver")).toMatchObject({ confidence: "exact" });
            expect(compare("1.5.0-r0", "1.5.0-r1", "apk")).toMatchObject({ confidence: "exact" });
        });

        it("reports fuzzy when a comparator had to guess", () => {
            // Not semver: three components plus a bare letter.
            expect(compare("1.0.2k", "1.0.2l", "semver")).toMatchObject({ confidence: "fuzzy" });
            // Not apk: the tail is not a `-r<n>` build component.
            expect(compare("1.0.0-alpha", "1.0.0-beta", "apk")).toMatchObject({
                confidence: "fuzzy",
            });
            // Not PEP 440: falls to the legacy setuptools ordering.
            expect(compare("2.0-dev-r1", "2.0-dev-r2", "pep440")).toMatchObject({
                confidence: "fuzzy",
            });
        });

        it("never reports exact for the fuzzy scheme (Appendix C #19)", () => {
            // An ecosystem with no comparator at all must never claim an exact
            // ordering, however well-formed the two versions happen to look.
            for (const [a, b] of [
                ["1.2.3", "1.2.4"],
                ["1.0.2k", "1.0.2l"],
                ["95SE", "98SP1"],
                ["1.0.0", "1.0.0"],
            ]) {
                expect(compare(a!, b!, "fuzzy"), `${a} vs ${b}`).toMatchObject({
                    confidence: "fuzzy",
                });
            }
        });
    });

    describe("dual-format retry", () => {
        it("upgrades a fuzzy primary to an exact fallback", () => {
            // An advisory bound written as semver, checked against an apk
            // package: `apk` cannot parse `-alpha`, `semver` can.
            const primary = compare("1.0.0-alpha", "1.0.0-beta", "apk");
            expect(primary).toMatchObject({ confidence: "fuzzy" });

            const retried = compare("1.0.0-alpha", "1.0.0-beta", "apk", {
                fallbackScheme: "semver",
            });
            expect(retried).toMatchObject({ cmp: -1, confidence: "exact" });
        });

        it("leaves an exact primary alone", () => {
            // `1.5.0-r1` is a real apk version; semver would mangle the `-r1`
            // into a prerelease and rank it below `1.5.0`.
            const withFallback = compare("1.5.0-r1", "1.5.0", "apk", { fallbackScheme: "semver" });
            expect(withFallback).toMatchObject({ cmp: 1, confidence: "exact" });
        });

        it("keeps the primary when the fallback is no better", () => {
            const result = compare("not a version", "not a version 2", "apk", {
                fallbackScheme: "dpkg",
            });
            // Still an answer, still honest about being a guess.
            expect(result).toMatchObject({ confidence: "fuzzy" });
        });

        it("ignores a fallback identical to the primary scheme", () => {
            const plain = compare("1.0.2k", "1.0.2l", "semver");
            const withFallback = compare("1.0.2k", "1.0.2l", "semver", {
                fallbackScheme: "semver",
            });
            expect(withFallback).toEqual(plain);
        });

        it("retries a null primary, not only a fuzzy one", () => {
            // `semver` refuses `go1.26.4-X:jsonv2`; the retry under `golang`
            // reads it exactly and is adopted.
            const retried = compare("go1.26.4-X:jsonv2", "1.12.16", "semver", {
                fallbackScheme: "golang",
            });
            expect(retried).toMatchObject({ cmp: 1, confidence: "exact" });
        });

        it("does not retry past the empty-version guard", () => {
            expect(compare("", "1.0.0", "apk", { fallbackScheme: "semver" })).toBeNull();
        });
    });

    describe("regression corpus (Appendix C)", () => {
        it("#5 rpm tolerates a one-sided epoch", () => {
            // Component `1.2.3-4.el9` against a range introduced at
            // `1:1.2.3-1.el9` and fixed at `1:1.2.3-5.el9`: at or above the
            // lower bound, below the upper one — affected.
            expect(compare("1.2.3-4.el9", "1:1.2.3-1.el9", "rpm")).toMatchObject({ cmp: 1 });
            expect(compare("1.2.3-4.el9", "1:1.2.3-5.el9", "rpm")).toMatchObject({ cmp: -1 });
        });

        it("#6 dpkg tolerates a one-sided epoch", () => {
            expect(compare("1.2.3-4", "1:1.2.3-1", "dpkg")).toMatchObject({ cmp: 1 });
            expect(compare("1.2.3-4", "1:1.2.3-5", "dpkg")).toMatchObject({ cmp: -1 });
        });

        it("#5/#6 zero-filling the missing epoch would break both", () => {
            // The behaviour we are explicitly not implementing: under native
            // semantics the component sits below the range's lower bound, so
            // every epoch-bearing advisory would read as "not yet introduced".
            expect(compare("1.2.3-4.el9", "1:1.2.3-1.el9", "rpm", { strict: true })).toMatchObject({
                cmp: -1,
            });
            expect(compare("1.2.3-4", "1:1.2.3-1", "dpkg", { strict: true })).toMatchObject({
                cmp: -1,
            });
        });

        it("#10 apk parses a leading v", () => {
            expect(compare("v1.5.0-r0", "1.5.0-r0", "apk")).toMatchObject({
                cmp: 0,
                confidence: "exact",
            });
            expect(compare("v1.5.0-r0", "1.5.0-r1", "apk")).toMatchObject({ cmp: -1 });
        });

        it("#11 apk compares leading-zero components as strings", () => {
            expect(compare("1.01", "1.1", "apk")).not.toMatchObject({ cmp: 0 });
        });

        it("#13 pep440 sorts dev releases below their base", () => {
            expect(compare("1.0.0.dev1", "1.0.0", "pep440")).toMatchObject({
                cmp: -1,
                confidence: "exact",
            });
        });

        it("#14 maven sorts rc below its base", () => {
            expect(compare("3.2.0rc2", "3.2.0", "maven")).toMatchObject({ cmp: -1 });
        });

        it("#15 gem sorts a letter segment below its base", () => {
            expect(compare("4.0.0.beta1", "4.0.0", "gem")).toMatchObject({ cmp: -1 });
        });

        it("#16 nuget ranks a fourth revision component above three", () => {
            expect(compare("1.10.0.1", "1.10.0", "nuget")).toMatchObject({ cmp: 1 });
        });
    });

    describe("apk specifics (§3.4)", () => {
        it("ranks build revisions numerically, not lexically", () => {
            // Plain semver ranks `-r10` below `-r9` on ASCII order.
            expect(compare("1.37.0-r10", "1.37.0-r9", "apk")).toMatchObject({ cmp: 1 });
        });

        it("treats a missing revision as -r0", () => {
            expect(compare("1.0.0-r0", "1.0.0", "apk")).toMatchObject({ cmp: 0 });
        });

        it("ignores the commit hash rather than ordering it lexically", () => {
            expect(compare("1.0.0~abc123-r0", "1.0.0~fff999-r0", "apk")).toMatchObject({ cmp: 0 });
        });

        it("orders the openssl letter suffix", () => {
            expect(compare("1.1.1v-r1", "1.1.1w-r1", "apk")).toMatchObject({ cmp: -1 });
            expect(compare("1.1.1", "1.1.1w", "apk")).toMatchObject({ cmp: -1 });
        });
    });

    describe("rpm/dpkg leniency is narrow", () => {
        it("still compares epochs when both sides carry one", () => {
            expect(compare("1:1.0-1", "2:1.0-1", "rpm")).toMatchObject({ cmp: -1 });
            expect(compare("1:1.0-1", "2:1.0-1", "dpkg")).toMatchObject({ cmp: -1 });
        });

        it("still compares releases when both sides carry one", () => {
            expect(compare("1.0-1", "1.0-2", "rpm")).toMatchObject({ cmp: -1 });
            expect(compare("1.0-1", "1.0-2", "dpkg")).toMatchObject({ cmp: -1 });
        });

        it("treats an advisory with no release as covering every release", () => {
            expect(compare("1.2.3-4.el9", "1.2.3", "rpm")).toMatchObject({ cmp: 0 });
        });

        it("does not let leniency mask a real version difference", () => {
            expect(compare("1.2.4-1", "1:1.2.3-1", "rpm")).toMatchObject({ cmp: 1 });
            expect(compare("1.2.2-1", "1:1.2.3-1", "rpm")).toMatchObject({ cmp: -1 });
        });
    });
});

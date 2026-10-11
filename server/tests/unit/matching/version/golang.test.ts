/**
 * The Go comparator: the normalizations in front of semver, and what each one
 * costs in confidence.
 *
 * There is no vendored corpus for Go — osv-scalibr maps it to plain semver, so
 * its generated corpus would assert exactly the behaviour this scheme exists to
 * replace. These cases come from grype `version/golang_version_test.go` and from
 * the spellings observed in our own SBOM data.
 *
 * Every case goes through `compare()` rather than `compareGolang()` directly,
 * because the dispatch and the empty-version guard are part of the contract.
 */

import { describe, expect, it } from "vitest";
import { compare } from "../../../../src/matching/version/index.js";

describe("golang scheme", () => {
    describe("the go stdlib prefix (§3.1)", () => {
        it("orders a go-prefixed version against a plain one", () => {
            // The defect this scheme was added for: under `semver` the
            // go-prefixed side parses to no components at all and sorts below
            // every bound, so `go1.24.1` read as "not yet introduced at 1.24.0".
            expect(compare("go1.24.1", "1.24.0", "golang")).toMatchObject({ cmp: 1 });
            expect(compare("go1.24.1", "1.24.2", "golang")).toMatchObject({ cmp: -1 });
            expect(compare("go1.24.1", "1.24.1", "golang")).toMatchObject({ cmp: 0 });
        });

        it("orders two go-prefixed versions", () => {
            expect(compare("go1.23.9", "go1.24.1", "golang")).toMatchObject({ cmp: -1 });
            expect(compare("go1.24.10", "go1.24.9", "golang")).toMatchObject({ cmp: 1 });
        });

        it("reports exact — the prefix is spelling, not a guess", () => {
            expect(compare("go1.24.1", "1.24.0", "golang")).toMatchObject({
                confidence: "exact",
            });
        });

        it("strips the prefix only when a digit follows", () => {
            // `gopkg` is not a version with a `go` prefix, and rewriting it to
            // `pkg` would order it against something it is not. Left alone it
            // has no numeric component, and semver refuses to order that
            // (`null`) rather than ranking it below everything.
            expect(compare("gopkg", "gopkg", "golang")).toBeNull();
            expect(compare("gopkg", "1.0.0", "golang")).toBeNull();
        });

        it("ignores a GOEXPERIMENT marker", () => {
            // `runtime.Version()` of a binary built with GOEXPERIMENT=jsonv2 is
            // `go1.26.4 X:jsonv2`; syft writes the space as `-`. Neither
            // spelling changes which stdlib release it is.
            expect(compare("go1.26.4-X:jsonv2", "1.26.4", "golang")).toMatchObject({
                cmp: 0,
                confidence: "exact",
            });
            expect(compare("go1.26.4 X:jsonv2", "1.25.13", "golang")).toMatchObject({
                cmp: 1,
                confidence: "exact",
            });
            expect(compare("go1.26.4-X:jsonv2,greenteagc", "1.26.6", "golang")).toMatchObject({
                cmp: -1,
            });
            // The purl form carries no `go` prefix; the marker must still go.
            expect(compare("1.26.4-X:jsonv2", "1.12.16", "golang")).toMatchObject({ cmp: 1 });
        });

        it("keeps build metadata after a GOEXPERIMENT marker", () => {
            expect(compare("go1.26.4-X:jsonv2+dirty", "1.26.4", "golang")).toMatchObject({
                cmp: 0,
                confidence: "exact",
            });
        });
    });

    describe("canonical Go versions", () => {
        it("handles the leading v", () => {
            expect(compare("v1.2.3", "v1.2.4", "golang")).toMatchObject({
                cmp: -1,
                confidence: "exact",
            });
            expect(compare("v1.2.3", "1.2.3", "golang")).toMatchObject({ cmp: 0 });
        });

        it("orders pseudo-versions by their timestamp", () => {
            const older = "v0.0.0-20200101120000-abcdef123456";
            const newer = "v0.0.0-20210506093000-fedcba654321";

            expect(compare(older, newer, "golang")).toMatchObject({
                cmp: -1,
                confidence: "exact",
            });
            expect(compare(newer, older, "golang")).toMatchObject({ cmp: 1 });
        });

        it("sorts a pseudo-version below the release it precedes", () => {
            expect(compare("v1.2.3-20200101120000-abcdef123456", "v1.2.3", "golang")).toMatchObject({ cmp: -1 });
        });

        it("sorts a prerelease below its release", () => {
            expect(compare("v1.2.3-rc1", "v1.2.3", "golang")).toMatchObject({ cmp: -1 });
        });
    });

    describe("build metadata", () => {
        it("ignores +incompatible, as semver requires", () => {
            expect(compare("v1.2.3+incompatible", "v1.2.3", "golang")).toMatchObject({
                cmp: 0,
                confidence: "exact",
            });
        });

        it("dot-separates the repeated metadata Go 1.24 emits", () => {
            expect(compare("v1.2.3+incompatible+dirty", "v1.2.3", "golang")).toMatchObject({
                cmp: 0,
                confidence: "exact",
            });
            expect(compare("v1.2.3+incompatible+dirty", "v1.2.4", "golang")).toMatchObject({
                cmp: -1,
            });
        });

        it("keeps the prefix strip and the metadata repair composable", () => {
            expect(compare("go1.24.1+dirty", "1.24.0", "golang")).toMatchObject({
                cmp: 1,
                confidence: "exact",
            });
        });
    });

    describe("glued-on prerelease tags", () => {
        it("reads a glued tag as a prerelease of its release", () => {
            expect(compare("9.6.0b1", "9.6.0", "golang")).toMatchObject({ cmp: -1 });
            expect(compare("9.6.0b1", "9.5.0", "golang")).toMatchObject({ cmp: 1 });
        });

        it("reports fuzzy — the separator is inferred, not spelled", () => {
            expect(compare("9.6.0b1", "9.6.0", "golang")).toMatchObject({ confidence: "fuzzy" });
            // …and the taint survives a well-formed counterpart.
            expect(compare("9.6.0", "9.6.0b1", "golang")).toMatchObject({ confidence: "fuzzy" });
        });

        it("leaves an already-separated prerelease alone", () => {
            expect(compare("9.6.0-b1", "9.6.0", "golang")).toMatchObject({
                cmp: -1,
                confidence: "exact",
            });
        });
    });

    describe("(devel)", () => {
        it("is indeterminate rather than a confident miss", () => {
            expect(compare("(devel)", "1.24.0", "golang")).toBeNull();
            expect(compare("1.24.0", "(devel)", "golang")).toBeNull();
        });

        it("is indeterminate even against itself", () => {
            // Two development builds are not the same version just because the
            // toolchain spells them the same way.
            expect(compare("(devel)", "(devel)", "golang")).toBeNull();
        });
    });

    describe("the dual-format retry (SEMVER-typed Go ranges)", () => {
        it("upgrades the semver primary that cannot read a go-prefixed version", () => {
            // OSV writes Go advisories as `SEMVER` ranges, so `ranges.ts` runs
            // `semver` as the primary scheme with the component's scheme as the
            // fallback. The primary has nothing numeric to order `go1.24.1` by
            // and says so; the retry under `golang` is what answers.
            expect(compare("go1.24.1", "1.24.0", "semver")).toBeNull();

            const retried = compare("go1.24.1", "1.24.0", "semver", { fallbackScheme: "golang" });
            expect(retried).toMatchObject({ cmp: 1, confidence: "exact" });
        });

        it("adopts the golang fallback for a GOEXPERIMENT-stamped stdlib", () => {
            // The trivy-adapter case: 140 stdlib advisories fixed between
            // 1.6.4 and 1.10.6 attached to a 1.26.4 binary, because `semver`
            // ranked `go1.26.4-X:jsonv2` below every bound and the `golang`
            // retry was only fuzzy (`:` is not a prerelease character), so it
            // was never adopted.
            const retried = compare("go1.26.4-X:jsonv2", "1.12.16", "semver", {
                fallbackScheme: "golang",
            });
            expect(retried).toMatchObject({ cmp: 1, confidence: "exact" });
        });
    });
});

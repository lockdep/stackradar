/**
 * Tag comparison, and — mostly — tag *refusal*.
 *
 * The bulk of these assertions are negative, which is the right ratio. The
 * damage a wrong recommendation does here is not "we suggested a slightly odd
 * upgrade": it is telling somebody to move from Debian to Alpine, or from a
 * pinned patch version to a floating major, and calling it a security fix.
 * Every `comparable: false` below is a specific version of that mistake.
 */

import { describe, it, expect } from "vitest";
import { bestNewerTag, bumpKind, compareTags, parseTag } from "../../../src/lib/image-tags.js";

describe("parseTag", () => {
    it("splits version from variant", () => {
        expect(parseTag("20.18-slim")).toMatchObject({ version: [20, 18], variant: "slim" });
        expect(parseTag("20.18")).toMatchObject({ version: [20, 18], variant: "" });
        expect(parseTag("1.25.2-alpine3.20")).toMatchObject({
            version: [1, 25, 2],
            variant: "alpine3.20",
        });
    });

    it("strips a leading v", () => {
        expect(parseTag("v1.2.3").version).toEqual([1, 2, 3]);
    });

    it("recognises a pre-release without mistaking a variant for one", () => {
        expect(parseTag("1.2.3-rc1").prerelease).toBe("rc1");
        expect(parseTag("1.2.3-beta.2").prerelease).toBe("beta.2");
        // The trap: `slim` is a variant, not a pre-release.
        expect(parseTag("20.18-slim").prerelease).toBeNull();
        expect(parseTag("3.12-bookworm").prerelease).toBeNull();
    });

    it("gives no version to tags that are not versions", () => {
        for (const tag of ["latest", "stable", "edge", "main", "sha-a1b2c3d"]) {
            expect(parseTag(tag).version).toBeNull();
        }
    });
});

describe("compareTags — what it refuses", () => {
    it("refuses to cross a variant boundary", () => {
        // The headline mistake: this is a base-distro change, not a bump.
        expect(compareTags("20.18-slim", "20.19-alpine")).toMatchObject({
            comparable: false,
            reason: "different-variant",
        });
        expect(compareTags("20.18", "20.19-slim")).toMatchObject({
            comparable: false,
            reason: "different-variant",
        });
        // Not even between two Alpines of different vintage.
        expect(compareTags("1.25-alpine3.19", "1.26-alpine3.20")).toMatchObject({
            comparable: false,
            reason: "different-variant",
        });
    });

    it("refuses to compare across precision", () => {
        // `20` already points at whatever `20.18` is, so neither direction is
        // an action: one is a no-op and the other is a loss of pinning.
        expect(compareTags("20", "20.18")).toMatchObject({
            comparable: false,
            reason: "different-precision",
        });
        expect(compareTags("20.18", "20")).toMatchObject({
            comparable: false,
            reason: "different-precision",
        });
    });

    it("reports the variant difference first when a tag differs on both", () => {
        // `20.11-slim` vs `21` differs on variant *and* precision, and both
        // readings are true. Variant wins because it is the more consequential
        // of the two: a precision mismatch is a pinning question, a variant
        // mismatch is a different operating system.
        expect(compareTags("20.11-slim", "21")).toMatchObject({
            comparable: false,
            reason: "different-variant",
        });
    });

    it("refuses non-version tags", () => {
        expect(compareTags("latest", "20.18")).toMatchObject({
            comparable: false,
            reason: "not-a-version",
        });
        expect(compareTags("20.18", "main")).toMatchObject({
            comparable: false,
            reason: "not-a-version",
        });
    });

    it("refuses pre-releases in either position", () => {
        expect(compareTags("1.2.3", "1.3.0-rc1")).toMatchObject({
            comparable: false,
            reason: "prerelease",
        });
        expect(compareTags("1.3.0-rc1", "1.3.0")).toMatchObject({
            comparable: false,
            reason: "prerelease",
        });
    });
});

describe("compareTags — what it allows", () => {
    it("orders same-variant, same-precision versions", () => {
        expect(compareTags("20.18", "20.19")).toEqual({ comparable: true, order: -1 });
        expect(compareTags("20.19", "20.18")).toEqual({ comparable: true, order: 1 });
        expect(compareTags("20.18", "20.18")).toEqual({ comparable: true, order: 0 });
        expect(compareTags("20.18-slim", "20.19-slim")).toEqual({ comparable: true, order: -1 });
    });

    it("compares numerically, not lexically", () => {
        // The classic: "9" > "10" as strings.
        expect(compareTags("1.9.0", "1.10.0")).toEqual({ comparable: true, order: -1 });
    });
});

describe("bumpKind", () => {
    it("names the component that moved", () => {
        expect(bumpKind("1.2.3", "2.0.0")).toBe("major");
        expect(bumpKind("1.2.3", "1.3.0")).toBe("minor");
        expect(bumpKind("1.2.3", "1.2.4")).toBe("patch");
        expect(bumpKind("1.2.3", "1.2.3")).toBe("none");
    });
});

describe("bestNewerTag", () => {
    it("picks the newest comparable tag and reports the rest", () => {
        const result = bestNewerTag("20.11-slim", [
            "20.9-slim",
            "20.18-slim",
            "20.14-slim",
            "20.18-alpine",
            "latest",
            "21-slim",
        ]);

        expect(result.best).toBe("20.18-slim");
        expect(result.newer).toEqual(["20.18-slim", "20.14-slim"]);
        // Everything refused is reported with a reason, never dropped — that
        // is what lets the UI say "ambiguous" instead of "up to date".
        expect(result.incomparable).toEqual(
            expect.arrayContaining([
                { tag: "20.18-alpine", reason: "different-variant" },
                { tag: "latest", reason: "not-a-version" },
                // Same variant, fewer components — the floating-major case.
                { tag: "21-slim", reason: "different-precision" },
            ]),
        );
    });

    it("distinguishes 'nothing newer' from 'nothing comparable'", () => {
        const upToDate = bestNewerTag("20.18-slim", ["20.11-slim", "20.14-slim"]);
        expect(upToDate.best).toBeNull();
        expect(upToDate.incomparable).toEqual([]);

        const ambiguous = bestNewerTag("20.18-slim", ["latest", "21-alpine"]);
        expect(ambiguous.best).toBeNull();
        expect(ambiguous.incomparable).toHaveLength(2);
    });

    it("never recommends the tag it was given", () => {
        expect(bestNewerTag("1.2.3", ["1.2.3", "1.2.3"]).best).toBeNull();
    });
});

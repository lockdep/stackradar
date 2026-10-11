import { describe, it, expect } from "vitest";
import {
    DEFAULT_COMMUNITY_ECOSYSTEMS,
    ecosystemArchiveUrl,
    missingFromScope,
    parseEcosystems,
    parseEcosystemsTxt,
    scopeCovers,
} from "../../../src/osv-sync/ecosystems.js";

const community = { isCloud: false };
const cloud = { isCloud: true };

/**
 * `OSV_ECOSYSTEMS`: the community edition
 * mirrors a list of ecosystems, the cloud mirrors everything, and the
 * variable overrides either. `null` is "everything" throughout.
 */
describe("parseEcosystems", () => {
    it("falls back to the edition's default when unset or blank", () => {
        for (const raw of [undefined, "", "   "]) {
            expect(parseEcosystems(raw, community)).toEqual([...DEFAULT_COMMUNITY_ECOSYSTEMS]);
            expect(parseEcosystems(raw, cloud)).toBeNull();
        }
    });

    it("takes a comma-separated list verbatim, trimmed, deduplicated and in order", () => {
        expect(parseEcosystems(" Alpine, Red Hat ,npm,,Alpine ", cloud)).toEqual(["Alpine", "Red Hat", "npm"]);
    });

    it("does not change case: OSV directory names are case-sensitive", () => {
        expect(parseEcosystems("redhat,PyPI", community)).toEqual(["redhat", "PyPI"]);
    });

    it("reads `*` and `all` as everything in either edition", () => {
        for (const raw of ["*", "all", "ALL", " * "]) {
            expect(parseEcosystems(raw, community)).toBeNull();
            expect(parseEcosystems(raw, cloud)).toBeNull();
        }
    });

    it("ships a community default of distro and package-manager ecosystems", () => {
        expect(DEFAULT_COMMUNITY_ECOSYSTEMS).toContain("Alpine");
        expect(DEFAULT_COMMUNITY_ECOSYSTEMS).toContain("Red Hat");
        expect(DEFAULT_COMMUNITY_ECOSYSTEMS).toContain("npm");
        expect(new Set(DEFAULT_COMMUNITY_ECOSYSTEMS).size).toBe(DEFAULT_COMMUNITY_ECOSYSTEMS.length);
    });
});

describe("scope coverage", () => {
    it("an unscoped mirror covers any request; only an unscoped mirror covers an unscoped request", () => {
        expect(scopeCovers(null, null)).toBe(true);
        expect(scopeCovers(null, ["Alpine"])).toBe(true);
        expect(scopeCovers(["Alpine"], null)).toBe(false);
        expect(missingFromScope(["Alpine"], null)).toEqual(["*"]);
    });

    it("names exactly the ecosystems the mirror lacks", () => {
        expect(missingFromScope(["Alpine", "npm"], ["Alpine", "npm"])).toEqual([]);
        expect(missingFromScope(["Alpine", "npm", "Go"], ["Alpine"])).toEqual([]);
        expect(missingFromScope(["Alpine"], ["Alpine", "Debian", "Go"])).toEqual(["Debian", "Go"]);
        expect(scopeCovers(["Alpine"], ["Debian"])).toBe(false);
    });
});

describe("bucket helpers", () => {
    it("URL-encodes directory names with spaces", () => {
        expect(ecosystemArchiveUrl("https://osv.example", "Red Hat")).toBe("https://osv.example/Red%20Hat/all.zip");
        expect(ecosystemArchiveUrl("https://osv.example", "crates.io")).toBe("https://osv.example/crates.io/all.zip");
    });

    it("parses ecosystems.txt, dropping blanks and the [EMPTY] placeholder", () => {
        const names = parseEcosystemsTxt("AlmaLinux\nAlpine\n\nRed Hat\n[EMPTY]\ncrates.io\n");
        expect([...names]).toEqual(["AlmaLinux", "Alpine", "Red Hat", "crates.io"]);
    });
});

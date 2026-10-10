/**
 * The EOL verdict is what separates "no fix yet — wait" from "this release
 * line will never get one — migrate the base image". The load-bearing cases
 * are the refusals: an ecosystem the table cannot judge must come back null,
 * never as a claim about a customer's base image.
 */

import { describe, it, expect } from "vitest";
import { eolVerdict } from "../../../src/lib/eol-releases.js";

const NOW = new Date("2026-08-16T00:00:00Z");

describe("eolVerdict", () => {
    it("calls a dead Alpine line EOL, with its date", () => {
        expect(eolVerdict("Alpine:v3.16", NOW)).toEqual({
            eol: true,
            releaseLine: "Alpine 3.16",
            eolDate: "2024-05-23",
        });
    });

    it("calls a still-supported line not EOL", () => {
        expect(eolVerdict("Alpine:v3.21", NOW)).toMatchObject({ eol: false });
        expect(eolVerdict("Debian:12", NOW)).toMatchObject({ eol: false });
    });

    it("flips on the date, not on table membership", () => {
        // Alpine 3.20's support ended 2026-04-01: EOL today, supported before.
        expect(eolVerdict("Alpine:v3.20", NOW)).toMatchObject({ eol: true });
        expect(eolVerdict("Alpine:v3.20", new Date("2026-03-01T00:00:00Z"))).toMatchObject({
            eol: false,
        });
    });

    it("handles Debian and Ubuntu spellings", () => {
        expect(eolVerdict("Debian:10", NOW)).toMatchObject({ eol: true, releaseLine: "Debian 10" });
        expect(eolVerdict("Ubuntu:20.04:LTS", NOW)).toMatchObject({
            eol: true,
            releaseLine: "Ubuntu 20.04",
        });
        expect(eolVerdict("Ubuntu:22.04:LTS", NOW)).toMatchObject({ eol: false });
    });

    it("treats Ubuntu Pro as covered, not as a lookup", () => {
        // Pro coverage means fixes still ship; 18.04 being past standard
        // support must not leak through as an EOL claim.
        expect(eolVerdict("Ubuntu:Pro:18.04:LTS", NOW)).toBeNull();
    });

    it("refuses what it does not know", () => {
        expect(eolVerdict(null, NOW)).toBeNull();
        expect(eolVerdict("npm", NOW)).toBeNull(); // a registry has no release line
        expect(eolVerdict("PyPI", NOW)).toBeNull();
        expect(eolVerdict("Wolfi:rolling", NOW)).toBeNull(); // unknown family
        expect(eolVerdict("Alpine:edge", NOW)).toBeNull(); // unknown release
        expect(eolVerdict("Red Hat:enterprise_linux:8::appstream", NOW)).toBeNull();
    });
});

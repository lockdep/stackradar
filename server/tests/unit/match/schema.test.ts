import { describe, it, expect } from "vitest";
import { matchRequestSchema, MATCH_MAX_COMPONENTS } from "../../../src/schemas/match.schema.js";

describe("POST /internal/match body", () => {
    it("accepts the minimal component and nullable optionals", () => {
        const parsed = matchRequestSchema.parse({
            components: [
                { name: "busybox" },
                { name: "openssl", purl: null, version: null },
                { name: "zlib", purl: "pkg:apk/alpine/zlib@1.3-r2", version: "1.3-r2" },
            ],
        });
        expect(parsed.components).toHaveLength(3);
        expect(parsed.components[0]).toEqual({ name: "busybox" });
    });

    it("requires at least one component", () => {
        expect(matchRequestSchema.safeParse({ components: [] }).success).toBe(false);
        expect(matchRequestSchema.safeParse({}).success).toBe(false);
    });

    it("requires a name on every component", () => {
        expect(matchRequestSchema.safeParse({ components: [{ purl: "pkg:npm/lodash@4.17.21" }] }).success).toBe(false);
        expect(matchRequestSchema.safeParse({ components: [{ name: "" }] }).success).toBe(false);
    });

    it("rejects anything but strings in the string fields", () => {
        expect(matchRequestSchema.safeParse({ components: [{ name: "x", version: 1 }] }).success).toBe(false);
    });

    it("caps a request at MATCH_MAX_COMPONENTS, defaulting to 20,000", () => {
        // The cap is enforced by the route (413), not the schema (422): the
        // schema's job is shape. This pins the default the route reads.
        expect(MATCH_MAX_COMPONENTS).toBe(20_000);
    });
});

/**
 * Guards the vendored OSV schema against silent drift.
 *
 * The schema in `src/schemas/osv-specifications/` is a copy of
 * `ossf/osv-schema@validation/schema.json`. Nothing fails when it goes stale —
 * conforming advisories simply get logged as validation warnings, which is how
 * 8,104 CleanStart (`CLSA-`) advisories came to be reported as "parse failures"
 * while being ingested perfectly.
 *
 * These tests are the offline half of `pnpm osv-schema:check` (which needs the
 * network and so lives in CI, not the suite): they prove the vendored bytes are
 * still the upstream bytes, and that the prefixes the stale copy was missing
 * now actually validate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateOsv } from "../../../src/validators/osv.validator.js";

const SCHEMA_DIR = join(import.meta.dirname, "../../../src/schemas/osv-specifications");

const lock = JSON.parse(readFileSync(join(SCHEMA_DIR, "osv.schema.lock.json"), "utf-8")) as {
    repo: string;
    commit: string;
    sha256: string;
};

describe("vendored OSV schema", () => {
    it("matches the checksum recorded in osv.schema.lock.json", () => {
        const actual = createHash("sha256")
            .update(readFileSync(join(SCHEMA_DIR, "osv.schema.json")))
            .digest("hex");

        expect(
            actual,
            `osv.schema.json no longer matches ${lock.repo}@${lock.commit.slice(0, 12)}. ` +
                "Upstream is the source of truth — run `pnpm osv-schema:sync` rather than editing it.",
        ).toBe(lock.sha256);
    });

    // One per prefix the stale copy rejected. A minimal record is enough:
    // `id` and `modified` are the only required fields, so anything that fails
    // here failed on the prefix pattern specifically.
    it.each(["CLSA-2024-1234", "BREW-2024-0001", "VCPKG-2024-0001"])(
        "accepts the %s ID prefix that the pre-refresh schema rejected",
        (id) => {
            const result = validateOsv({ id, modified: "2026-01-01T00:00:00Z" });
            expect(result.errors).toEqual([]);
            expect(result.valid).toBe(true);
        },
    );

    it.each(["Homebrew", "TuxCare", "vcpkg", "WordPress"])(
        "accepts the %s ecosystem that the pre-refresh schema rejected",
        (ecosystem) => {
            const result = validateOsv({
                id: "CVE-2024-0001",
                modified: "2026-01-01T00:00:00Z",
                affected: [{ package: { ecosystem, name: "example" } }],
            });
            expect(result.errors).toEqual([]);
            expect(result.valid).toBe(true);
        },
    );

    it("still rejects an ID whose prefix is in no known database", () => {
        // Without this the prefix assertions above would pass against a schema
        // that had stopped checking prefixes at all.
        const result = validateOsv({ id: "NOTADB-2024-0001", modified: "2026-01-01T00:00:00Z" });
        expect(result.valid).toBe(false);
        expect(result.errors[0]?.path).toBe("/id");
    });
});

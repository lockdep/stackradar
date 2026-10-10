/**
 * Version ordering parity with the chart index. The chart index worker
 * carries a copy of `parseTag` / `compareTags` / `bestNewerTag`
 * (`charts/src/worker/select/versions.ts`, ADR 0001: copies, not a shared
 * package). `tests/fixtures/version-conformance/version-order.json` is the
 * same file as `charts/tests/fixtures/version-order.json` —
 * `scripts/check-cross-app-constants.mjs` holds them byte-equal — and both
 * sides run its `pairs`, so a rule that changes here fails there too.
 * (`newest` in the fixture is the chart index's addition; it has no
 * counterpart in this module.)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compareTags } from "../../../src/lib/image-tags.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/version-conformance/version-order.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
    pairs: [string, "<" | "=" | ">" | "?", string][];
};

describe("compareTags (fixture shared with charts/)", () => {
    it.each(fixture.pairs)("%s %s %s", (a, op, b) => {
        const cmp = compareTags(a, b);
        if (op === "?") {
            expect(cmp.comparable).toBe(false);
            return;
        }
        expect(cmp.comparable).toBe(true);
        if (!cmp.comparable) return;
        expect(Math.sign(cmp.order)).toBe(op === "<" ? -1 : op === ">" ? 1 : 0);
    });
});

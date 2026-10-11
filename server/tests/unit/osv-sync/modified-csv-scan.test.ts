/**
 * scanModifiedCsv — the streaming replacement for parsing modified_id.csv whole
 *
 * The real file is 45.8 MB / 896k lines going back to 2002, sorted newest-first,
 * of which a typical hour touches ~220. Reading all of it to find them cost a
 * few hundred MB of peak heap on every run.
 *
 * Two things have to hold for stopping early to be safe:
 *   - the entries kept are exactly the ones a full parse would have kept, and
 *   - the newest-first ordering it relies on is *checked*, not assumed, because
 *     it is an OSV implementation detail rather than a documented guarantee.
 */

import { describe, it, expect } from "vitest";
import { scanModifiedCsv, updateCutoff } from "../../../src/osv-sync/parser.js";

async function* linesOf(csv: string): AsyncGenerator<string> {
    for (const line of csv.split("\n")) yield line;
}

/**
 * A line stream that records how far it was read — the whole point of the
 * change is that the tail of the file is never touched.
 */
function countingLines(csv: string): { lines: AsyncGenerator<string>; consumed: () => number } {
    let consumed = 0;
    async function* gen(): AsyncGenerator<string> {
        for (const line of csv.split("\n")) {
            consumed++;
            yield line;
        }
    }
    return { lines: gen(), consumed: () => consumed };
}

function csvOf(rows: [string, string][]): string {
    return ["modified,path", ...rows.map(([ts, path]) => `${ts},${path}`)].join("\n");
}

describe("scanModifiedCsv", () => {
    it("stops at the cutoff instead of reading the rest of the file", async () => {
        const tail: [string, string][] = Array.from({ length: 2000 }, (_, i) => [
            new Date(Date.UTC(2002, 0, 1, 0, 0, 2000 - i)).toISOString(),
            `npm/CVE-2002-${String(i).padStart(4, "0")}`,
        ]);
        const csv = csvOf([
            ["2026-08-05T10:00:00Z", "npm/CVE-2026-0002"],
            ["2026-08-05T09:00:00Z", "npm/CVE-2026-0001"],
            ...tail,
        ]);
        const { lines, consumed } = countingLines(csv);

        const scan = await scanModifiedCsv(lines, new Date("2026-08-05T08:00:00Z"));

        expect(scan.entries.map((e) => e.vulnId)).toEqual(["CVE-2026-0002", "CVE-2026-0001"]);
        expect(scan.stoppedEarly).toBe(true);
        // Header, two matches, and the confirmation window — not the 2000-line
        // tail, which is what 24 years of history looks like in the real file.
        expect(consumed()).toBeLessThan(60);
    });

    it("keeps exactly what a full parse plus filter would have kept", async () => {
        const rows: [string, string][] = Array.from({ length: 50 }, (_, i) => [
            new Date(Date.UTC(2026, 0, 1, 0, 50 - i)).toISOString(),
            `npm/CVE-2026-${String(i).padStart(4, "0")}`,
        ]);
        const csv = csvOf(rows);
        const cutoff = updateCutoff(new Date("2026-01-01T00:30:00Z"), 10);

        const scan = await scanModifiedCsv(linesOf(csv), cutoff);
        // The full-parse oracle, computed from the rows the CSV was built from
        // (parseModifiedCsv, the superseded whole-file parser, is gone).
        const expected = rows
            .filter(([ts]) => new Date(ts) >= cutoff!)
            .map(([, path]) => path.slice(path.indexOf("/") + 1));

        expect(scan.entries.map((e) => e.vulnId)).toEqual(expected);
    });

    it("reads the whole file when there is no watermark yet", async () => {
        const csv = csvOf([
            ["2026-08-05T10:00:00Z", "npm/CVE-2026-0002"],
            ["2002-01-01T00:00:00Z", "npm/CVE-2002-0001"],
        ]);

        const scan = await scanModifiedCsv(linesOf(csv), null);

        expect(scan.entries).toHaveLength(2);
        expect(scan.stoppedEarly).toBe(false);
    });

    it("falls back to a full scan when the file is not sorted newest-first", async () => {
        // An old line early on, with newer ones behind it: a scan that trusted
        // the ordering would stop and never see them.
        const tail: [string, string][] = Array.from({ length: 100 }, (_, i) => [
            new Date(Date.UTC(2002, 0, 1, 0, 0, 100 - i)).toISOString(),
            `npm/CVE-2002-${String(i).padStart(4, "0")}`,
        ]);
        const csv = csvOf([
            ["2026-08-05T10:00:00Z", "npm/CVE-2026-0001"],
            ["2002-06-01T00:00:00Z", "npm/CVE-2002-9999"],
            ["2026-08-05T09:00:00Z", "npm/CVE-2026-0002"],
            ...tail,
        ]);

        const scan = await scanModifiedCsv(linesOf(csv), new Date("2026-08-05T08:00:00Z"));

        expect(scan.orderingViolated).toBe(true);
        // Having seen the ordering broken once, it reads to EOF — which is
        // exactly the behaviour it replaced, and the right thing to degrade to.
        expect(scan.stoppedEarly).toBe(false);
        expect(scan.entries.map((e) => e.vulnId)).toEqual(["CVE-2026-0001", "CVE-2026-0002"]);
    });

    it("reports the newest timestamp in the file, not just of the kept entries", async () => {
        const csv = csvOf([
            ["2026-08-05T10:00:00Z", "npm/CVE-2026-0001"],
            ["2002-01-01T00:00:00Z", "npm/CVE-2002-0001"],
        ]);

        const scan = await scanModifiedCsv(linesOf(csv), new Date("2026-08-05T09:00:00Z"));

        expect(scan.maxModifiedSeen).toEqual(new Date("2026-08-05T10:00:00Z"));
        expect(scan.linesParsed).toBe(2);
    });

    it("skips the header and malformed lines without counting them", async () => {
        const csv = [
            "modified,path",
            "not-a-timestamp,npm/CVE-2026-0001",
            "2026-08-05T10:00:00Z,no-slash-here",
            "no-comma-at-all",
            "",
            "2026-08-05T09:00:00Z,npm/CVE-2026-0002",
        ].join("\n");

        const scan = await scanModifiedCsv(linesOf(csv), null);

        expect(scan.linesParsed).toBe(1);
        expect(scan.entries.map((e) => e.vulnId)).toEqual(["CVE-2026-0002"]);
    });

    it("reports an empty file as nothing parsed", async () => {
        const scan = await scanModifiedCsv(linesOf(""), null);

        expect(scan.linesParsed).toBe(0);
        expect(scan.maxModifiedSeen).toBeNull();
        expect(scan.entries).toEqual([]);
    });
});

/**
 * The KEV sync, with the delisting half under a microscope.
 *
 * Adding a KEV listing is the easy direction and is covered here in one test.
 * The rest of this file is about *removal*, because `kev_listed_at` pins
 * `exploitability` at 1.0 and a listing that outlives its source holds a
 * finding at the top of every list in the product on evidence CISA has
 * withdrawn. That, and the fact that a full-replacement sync turns a truncated
 * download into a mass deletion.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, getTestPgClient, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { KEV_APPLY_LOCK_KEY, loadConfig } from "../../../src/kev-sync/config.js";
import { parseCatalog } from "../../../src/kev-sync/parser.js";
import { withFindingIdentity } from "../../fixtures/seed-data.js";

type Repo = typeof import("../../../src/kev-sync/repository.js");

async function repository(): Promise<Repo> {
    return import("../../../src/kev-sync/repository.js");
}

const config = { ...loadConfig(), minEntriesToApply: 1 };

function entry(cve: string, dateAdded: string, opts: { due?: string; ransomware?: string } = {}) {
    return {
        cve,
        dateAdded: new Date(dateAdded),
        dueDate: opts.due ? new Date(opts.due) : null,
        ransomware: opts.ransomware ?? "Unknown",
    };
}

async function seedAdvisories() {
    const db = getTestDb();
    await db.insert(schema.vulnerabilities).values(
        withFindingIdentity([
            { vulnId: "CVE-2021-44228", source: "osv", cvssScore: 10, severityLevel: "critical", aliases: [] },
            {
                vulnId: "GHSA-jfh8-c2jp-5v3q",
                source: "osv",
                cvssScore: 10,
                severityLevel: "critical",
                aliases: ["CVE-2021-44228"],
            },
            { vulnId: "CVE-2019-0708", source: "osv", cvssScore: 9.8, severityLevel: "critical", aliases: [] },
            {
                vulnId: "GHSA-two-cves-xxxx",
                source: "osv",
                cvssScore: 7.5,
                severityLevel: "high",
                aliases: ["CVE-2021-44228", "CVE-2019-0708"],
            },
            // A distro tracker record: no aliases, the CVE only under `upstream`.
            {
                vulnId: "UBUNTU-CVE-2019-0708",
                source: "osv",
                cvssScore: 9.8,
                severityLevel: "critical",
                aliases: [],
                rawData: { upstream: ["CVE-2019-0708"] },
            },
        ]),
    );
}

describe("KEV sync", () => {
    beforeAll(async () => {
        await cleanAllData();
    });

    beforeEach(async () => {
        const db = getTestDb();
        await db.delete(schema.componentVulnerabilities);
        await db.delete(schema.vulnerabilities);
        await db.delete(schema.kevSyncState);
        await seedAdvisories();
    });

    it("lists by CVE id and by alias, and takes the earliest date for a multi-alias advisory", async () => {
        const db = getTestDb();
        const { createKevRepository } = await repository();

        const result = await createKevRepository().apply(
            [
                entry("CVE-2021-44228", "2021-12-10", { due: "2021-12-24", ransomware: "Known" }),
                entry("CVE-2019-0708", "2019-05-14", { due: "2022-05-03" }),
            ],
            { minEntries: config.minEntriesToApply },
        );

        expect(result.entriesMatched).toBe(5);

        const rows = await db.select().from(schema.vulnerabilities);
        const byId = new Map(rows.map((r) => [r.vulnId, r]));

        expect(byId.get("CVE-2021-44228")!.kevListedAt?.toISOString()).toContain("2021-12-10");
        expect(byId.get("CVE-2021-44228")!.kevRansomware).toBe("Known");
        // The alias path, again the difference between npm findings ranking on
        // exploitation and ranking on CVSS alone.
        expect(byId.get("GHSA-jfh8-c2jp-5v3q")!.kevListedAt?.toISOString()).toContain("2021-12-10");
        // The `upstream` path: the row that survives the collapse for an
        // Ubuntu deb finding names its CVE nowhere else.
        expect(byId.get("UBUNTU-CVE-2019-0708")!.kevListedAt?.toISOString()).toContain("2019-05-14");

        // Two listed CVEs on one advisory: "known exploited since" is a claim
        // about the first of them, and the binding deadline is the earliest.
        const multi = byId.get("GHSA-two-cves-xxxx")!;
        expect(multi.kevListedAt?.toISOString()).toContain("2019-05-14");
        expect(multi.kevDueDate?.toISOString()).toContain("2021-12-24");
        // Ransomware use of *any* covered CVE makes the advisory ransomware-used.
        expect(multi.kevRansomware).toBe("Known");
    });

    it("takes the risk score to its ceiling and back when CISA delists", async () => {
        const db = getTestDb();
        const { createKevRepository } = await repository();
        const repo = createKevRepository();

        const riskOf = async (vulnId: string) => {
            const [row] = await db
                .select({ risk: schema.vulnerabilities.riskScore })
                .from(schema.vulnerabilities)
                .where(eq(schema.vulnerabilities.vulnId, vulnId));
            return row!.risk!;
        };

        // CVSS 10, no EPSS → 10. Listed → 100.
        expect(await riskOf("CVE-2021-44228")).toBeCloseTo(10, 1);
        await repo.apply([entry("CVE-2021-44228", "2021-12-10")], { minEntries: 1 });
        expect(await riskOf("CVE-2021-44228")).toBeCloseTo(100, 1);

        // A later catalogue without it. This is the whole reason the sync
        // replaces rather than upserts — a listing that survives its source
        // holds the finding at the top of every list forever.
        const result = await repo.apply([entry("CVE-2019-0708", "2019-05-14")], { minEntries: 1 });
        expect(result.advisoriesCleared).toBeGreaterThan(0);
        expect(await riskOf("CVE-2021-44228")).toBeCloseTo(10, 1);

        const [row] = await db
            .select({ due: schema.vulnerabilities.kevDueDate, r: schema.vulnerabilities.kevRansomware })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "CVE-2021-44228"));
        // Every KEV column goes, not just the timestamp.
        expect(row!.due).toBeNull();
        expect(row!.r).toBeNull();
    });

    it("clears an aliased advisory too, not only the CVE record", async () => {
        const db = getTestDb();
        const { createKevRepository } = await repository();
        const repo = createKevRepository();

        await repo.apply([entry("CVE-2021-44228", "2021-12-10")], { minEntries: 1 });
        await repo.apply([entry("CVE-2019-0708", "2019-05-14")], { minEntries: 1 });

        const [ghsa] = await db
            .select({ listed: schema.vulnerabilities.kevListedAt })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "GHSA-jfh8-c2jp-5v3q"));
        expect(ghsa!.listed).toBeNull();
    });

    // Same rule as EPSS: a second process applying the catalogue skips on
    // the transaction advisory lock rather than replacing the same rows.
    it("refuses to apply while another process holds the apply lock, and the worker reports a skip", async () => {
        const { createKevRepository } = await repository();
        const { createKevSyncWorker } = await import("../../../src/kev-sync/worker.js");
        const holder = await getTestPgClient().reserve();
        try {
            await holder`SELECT pg_advisory_lock(${KEV_APPLY_LOCK_KEY})`;

            await expect(
                createKevRepository().apply([entry("CVE-2021-44228", "2021-12-10")], { minEntries: 1 }),
            ).rejects.toThrow(/advisory lock held/);

            // The worker turns that into a skip, not a failure: nothing is
            // written, and the state row is not given a "last error".
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(
                    JSON.stringify({
                        catalogVersion: "2026.10.10",
                        count: 1,
                        vulnerabilities: [
                            {
                                cveID: "CVE-2021-44228",
                                dateAdded: "2021-12-10",
                                dueDate: "2021-12-24",
                                knownRansomwareCampaignUse: "Known",
                            },
                        ],
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
            try {
                const result = await createKevSyncWorker(
                    { ...loadConfig(), minEntriesToApply: 1 },
                    createKevRepository(),
                ).runOnce();
                expect(result).toEqual({ skipped: true, reason: "locked" });
            } finally {
                fetchSpy.mockRestore();
            }
            // The worker did stamp `run_started_at` before trying the lock —
            // the other process's completion clears it — but it recorded
            // neither a sync nor an error.
            const state = await createKevRepository().getState();
            expect(state?.lastSyncedAt ?? null).toBeNull();
            expect(state?.lastError ?? null).toBeNull();
        } finally {
            await holder`SELECT pg_advisory_unlock(${KEV_APPLY_LOCK_KEY})`;
            holder.release();
        }
    });

    it("refuses a truncated catalogue rather than clearing everything", async () => {
        const db = getTestDb();
        const { createKevRepository, ShortCatalogError } = await repository();
        const repo = createKevRepository();

        await repo.apply([entry("CVE-2021-44228", "2021-12-10"), entry("CVE-2019-0708", "2019-05-14")], {
            minEntries: 1,
        });

        // One entry where there were 1,600 is not a delisting event, it is a
        // broken download — and for a replacement sync that is a mass deletion.
        await expect(repo.apply([entry("CVE-2019-0708", "2019-05-14")], { minEntries: 500 })).rejects.toBeInstanceOf(
            ShortCatalogError,
        );

        const [row] = await db
            .select({ listed: schema.vulnerabilities.kevListedAt })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "CVE-2021-44228"));
        expect(row!.listed).not.toBeNull();
    });

    it("rewrites nothing when the catalogue has not changed", async () => {
        const { createKevRepository } = await repository();
        const repo = createKevRepository();
        const catalog = [entry("CVE-2021-44228", "2021-12-10", { due: "2021-12-24", ransomware: "Known" })];

        const first = await repo.apply(catalog, { minEntries: 1 });
        expect(first.advisoriesListed).toBeGreaterThan(0);

        const second = await repo.apply(catalog, { minEntries: 1 });
        expect(second.advisoriesListed).toBe(0);
        expect(second.advisoriesCleared).toBe(0);
    });
});

describe("KEV parser", () => {
    it("keeps only the four fields KEV uniquely knows", () => {
        const catalog = parseCatalog({
            catalogVersion: "2026.08.15",
            dateReleased: "2026-08-15T14:00:00.0000Z",
            count: 1,
            vulnerabilities: [
                {
                    cveID: "CVE-2021-44228",
                    vendorProject: "Apache",
                    product: "Log4j2",
                    shortDescription: "…",
                    dateAdded: "2021-12-10",
                    dueDate: "2021-12-24",
                    knownRansomwareCampaignUse: "Known",
                },
            ],
        });

        expect(catalog.catalogVersion).toBe("2026.08.15");
        expect(catalog.declaredCount).toBe(1);
        expect(catalog.entries).toEqual([
            {
                cve: "CVE-2021-44228",
                dateAdded: new Date("2021-12-10"),
                dueDate: new Date("2021-12-24"),
                ransomware: "Known",
            },
        ]);
    });

    it("drops an entry with no dateAdded rather than defaulting it to today", () => {
        // A fabricated date would say CISA confirmed exploitation on the day we
        // happened to sync.
        const catalog = parseCatalog({
            vulnerabilities: [
                { cveID: "CVE-2021-44228" },
                { cveID: "NOT-A-CVE", dateAdded: "2021-12-10" },
                { cveID: "CVE-2019-0708", dateAdded: "2019-05-14" },
            ],
        });
        expect(catalog.entries.map((e) => e.cve)).toEqual(["CVE-2019-0708"]);
        expect(catalog.malformed).toBe(2);
    });

    it("throws on a document that is not a catalogue at all", () => {
        expect(() => parseCatalog({ error: "not found" })).toThrow(/vulnerabilities/);
        expect(() => parseCatalog("nope")).toThrow();
    });
});

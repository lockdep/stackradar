/**
 * Affected Package Repository Tests
 *
 * Tests the vulnerability_affected_packages lookup table operations:
 * - bulkInsert: batch insert with chunking
 * - replaceForVulns: atomic delete + insert for incremental updates
 * - deleteByVulnIds, truncate, getCount
 * - the generation swap: build alongside, promote atomically, discard on failure
 *
 * Uses Testcontainers (real PostgreSQL). vulnerabilities rows are inserted
 * first to satisfy the FK constraint. seedVulns() returns a UUID map so
 * tests can reference the correct UUIDs.
 *
 * Writes here pass generation 1 explicitly: with no osv_sync_state row the
 * pointer resolves to 1 (the column default), so these rows are the live ones.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { getTestDb } from "../../setup/test-db.js";
import {
    createOsvAffectedPackageRepository,
    type OsvAffectedPackageRepository,
} from "../../../src/osv-sync/affected-package-repository.js";
import {
    vulnerabilityAffectedPackages,
    type NewVulnerabilityAffectedPackage,
} from "../../../src/db/schema/vulnerabilities.js";
import { isCurrentGeneration } from "../../../src/db/generation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert minimal vulnerability rows and return a map from alias → UUID.
 * The alias is just a human-readable label used within a single test.
 */
async function seedVulns(...aliases: string[]): Promise<Map<string, string>> {
    const db = getTestDb();
    const uuidMap = new Map<string, string>();

    for (const alias of aliases) {
        const rows = await db.execute<{ id: string }>(sql`
            INSERT INTO vulnerabilities (
                id, vuln_id, source, severity_level, created_at, updated_at
            ) VALUES (
                gen_random_uuid(),
                ${"TEST-" + alias},
                'osv',
                'unknown',
                NOW(), NOW()
            )
            RETURNING id
        `);
        uuidMap.set(alias, rows[0]!.id);
    }

    return uuidMap;
}

function makeAffectedPkg(
    vulnerabilityId: string,
    overrides: Partial<NewVulnerabilityAffectedPackage> = {}
): NewVulnerabilityAffectedPackage {
    return {
        vulnerabilityId,
        ecosystem: "npm",
        ecosystemFamily: "npm",
        ecosystemRelease: null,
        packageName: "test-package",
        purl: "pkg:npm/test-package",
        matchKey: "npm|test-package",
        withdrawn: false,
        versions: null,
        ranges: null,
        fixedVersion: null,
        ...overrides,
    };
}

/**
 * Live-generation probe: the rows for one base PURL, scoped the way every
 * production read is (`isCurrentGeneration`). This is the observation the
 * suite uses to see what a write actually did; production matching itself
 * goes through `matching/store.ts` keyed on match_key.
 */
function findByPurl(basePurl: string) {
    const db = getTestDb();
    return db
        .select({
            vulnerabilityId: vulnerabilityAffectedPackages.vulnerabilityId,
            ecosystem: vulnerabilityAffectedPackages.ecosystem,
            packageName: vulnerabilityAffectedPackages.packageName,
            purl: vulnerabilityAffectedPackages.purl,
            versions: vulnerabilityAffectedPackages.versions,
            ranges: vulnerabilityAffectedPackages.ranges,
            fixedVersion: vulnerabilityAffectedPackages.fixedVersion,
        })
        .from(vulnerabilityAffectedPackages)
        .where(and(eq(vulnerabilityAffectedPackages.purl, basePurl), isCurrentGeneration()));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("OsvAffectedPackageRepository", () => {
    let repo: OsvAffectedPackageRepository;

    beforeAll(() => {
        const db = getTestDb();
        repo = createOsvAffectedPackageRepository(db);
    });

    beforeEach(async () => {
        const db = getTestDb();
        // Truncate affected packages then vulnerabilities (FK order)
        await db.execute(sql`TRUNCATE TABLE vulnerability_affected_packages`);
        // Before `vulnerabilities`, for the same reason `cleanAllData` does it:
        // `comp_vuln_vuln_fk` is RESTRICT, so a match row left behind by
        // whichever file ran before this one makes the delete below throw. Files
        // share one database and run sequentially, so that failure lands here
        // rather than where it was caused — and which file runs before this one
        // changes whenever a test file is added.
        await db.execute(sql`DELETE FROM component_vulnerabilities`);
        await db.execute(sql`DELETE FROM vulnerabilities WHERE source = 'osv'`);
        // Reset the generation pointer: the reads below are all scoped to it,
        // and a row left behind by another suite would hide every seeded row.
        await db.execute(sql`DELETE FROM osv_sync_state`);
    });

    // ---------------------------------------------------------------------------
    // getCount
    // ---------------------------------------------------------------------------

    describe("getCount", () => {
        it("returns 0 for an empty table", async () => {
            expect(await repo.getCount()).toBe(0);
        });

        it("returns the total row count", async () => {
            const ids = await seedVulns("V-001", "V-002");
            await repo.bulkInsert([
                makeAffectedPkg(ids.get("V-001")!),
                makeAffectedPkg(ids.get("V-001")!, { packageName: "other" }),
                makeAffectedPkg(ids.get("V-002")!),
            ], 1);
            expect(await repo.getCount()).toBe(3);
        });
    });

    // ---------------------------------------------------------------------------
    // bulkInsert
    // ---------------------------------------------------------------------------

    describe("bulkInsert", () => {
        it("inserts rows and returns the count", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            const inserted = await repo.bulkInsert([
                makeAffectedPkg(id, { packageName: "pkg-a" }),
                makeAffectedPkg(id, { packageName: "pkg-b" }),
            ], 1);
            expect(inserted).toBe(2);
            expect(await repo.getCount()).toBe(2);
        });

        it("returns 0 and inserts nothing for an empty array", async () => {
            const inserted = await repo.bulkInsert([], 1);
            expect(inserted).toBe(0);
            expect(await repo.getCount()).toBe(0);
        });

        it("stores versions and ranges as JSONB", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            await repo.bulkInsert([
                makeAffectedPkg(id, {
                    purl: "pkg:npm/lodash",
                    versions: ["4.17.20", "4.17.21"],
                    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
                    fixedVersion: "4.17.21",
                }),
            ], 1);

            const matches = await findByPurl("pkg:npm/lodash");
            expect(matches).toHaveLength(1);
            expect(matches[0]!.versions).toEqual(["4.17.20", "4.17.21"]);
            expect(matches[0]!.ranges).toMatchObject([{ type: "SEMVER" }]);
            expect(matches[0]!.fixedVersion).toBe("4.17.21");
        });

        it("handles null purl, namespace, versions, and ranges", async () => {
            const ids = await seedVulns("V-001");
            await repo.bulkInsert([
                makeAffectedPkg(ids.get("V-001")!, {
                    purl: null,
                    versions: null,
                    ranges: null,
                    fixedVersion: null,
                }),
            ], 1);
            expect(await repo.getCount()).toBe(1);
        });

        it("handles more than 500 rows (exercises chunking logic)", async () => {
            const ids = await seedVulns("V-BIG");
            const id = ids.get("V-BIG")!;
            const rows = Array.from({ length: 501 }, (_, i) =>
                makeAffectedPkg(id, { packageName: `pkg-${i}` })
            );
            const inserted = await repo.bulkInsert(rows, 1);
            expect(inserted).toBe(501);
            expect(await repo.getCount()).toBe(501);
        });
    });

    // ---------------------------------------------------------------------------
    // replaceForVulns
    // ---------------------------------------------------------------------------

    describe("replaceForVulns", () => {
        it("returns early without hitting DB for empty vulnIds", async () => {
            const result = await repo.replaceForVulns([], [], 1);
            expect(result).toEqual({ deleted: 0, inserted: 0 });
            expect(await repo.getCount()).toBe(0);
        });

        it("deletes existing rows and inserts new ones atomically", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            await repo.bulkInsert([
                makeAffectedPkg(id, { purl: "pkg:npm/old-a" }),
                makeAffectedPkg(id, { purl: "pkg:npm/old-b" }),
            ], 1);
            expect(await repo.getCount()).toBe(2);

            const result = await repo.replaceForVulns(
                [id],
                [makeAffectedPkg(id, { purl: "pkg:npm/new-a" })],
                1
            );

            expect(result.deleted).toBe(2);
            expect(result.inserted).toBe(1);
            expect(await repo.getCount()).toBe(1);
            expect(await findByPurl("pkg:npm/old-a")).toHaveLength(0);
            expect(await findByPurl("pkg:npm/new-a")).toHaveLength(1);
        });

        it("deletes existing rows even when the new rows list is empty", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            await repo.bulkInsert([makeAffectedPkg(id)], 1);

            const result = await repo.replaceForVulns([id], [], 1);

            expect(result.deleted).toBe(1);
            expect(result.inserted).toBe(0);
            expect(await repo.getCount()).toBe(0);
        });

        it("only touches rows belonging to the specified vuln IDs", async () => {
            const ids = await seedVulns("V-001", "V-002");
            const id1 = ids.get("V-001")!;
            const id2 = ids.get("V-002")!;
            await repo.bulkInsert([
                makeAffectedPkg(id1, { purl: "pkg:npm/from-v001" }),
                makeAffectedPkg(id2, { purl: "pkg:npm/from-v002" }),
            ], 1);

            await repo.replaceForVulns([id1], [], 1);

            expect(await repo.getCount()).toBe(1);
            expect(await findByPurl("pkg:npm/from-v002")).toHaveLength(1);
        });

        it("handles multiple vuln IDs in a single replace", async () => {
            const ids = await seedVulns("V-001", "V-002");
            const id1 = ids.get("V-001")!;
            const id2 = ids.get("V-002")!;
            await repo.bulkInsert([
                makeAffectedPkg(id1, { purl: "pkg:npm/old-1" }),
                makeAffectedPkg(id2, { purl: "pkg:npm/old-2" }),
            ], 1);

            await repo.replaceForVulns(
                [id1, id2],
                [
                    makeAffectedPkg(id1, { purl: "pkg:npm/new-1" }),
                    makeAffectedPkg(id2, { purl: "pkg:npm/new-2" }),
                ],
                1
            );

            expect(await repo.getCount()).toBe(2);
            expect(await findByPurl("pkg:npm/old-1")).toHaveLength(0);
            expect(await findByPurl("pkg:npm/new-1")).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------------------
    // deleteByVulnIds
    // ---------------------------------------------------------------------------

    describe("deleteByVulnIds", () => {
        it("deletes rows for the given vuln IDs", async () => {
            const ids = await seedVulns("V-001", "V-002");
            await repo.bulkInsert([
                makeAffectedPkg(ids.get("V-001")!),
                makeAffectedPkg(ids.get("V-002")!),
            ], 1);

            const deleted = await repo.deleteByVulnIds([ids.get("V-001")!]);

            expect(deleted).toBe(1);
            expect(await repo.getCount()).toBe(1);
        });

        it("returns 0 for empty input", async () => {
            expect(await repo.deleteByVulnIds([])).toBe(0);
        });

        it("returns 0 for unknown IDs", async () => {
            expect(await repo.deleteByVulnIds(["00000000-0000-0000-0000-000000000000"])).toBe(0);
        });
    });

    // ---------------------------------------------------------------------------
    // truncate
    // ---------------------------------------------------------------------------

    describe("truncate", () => {
        it("removes all rows from the table", async () => {
            const ids = await seedVulns("V-001", "V-002");
            await repo.bulkInsert([
                makeAffectedPkg(ids.get("V-001")!),
                makeAffectedPkg(ids.get("V-002")!),
            ], 1);
            expect(await repo.getCount()).toBe(2);

            await repo.truncate();

            expect(await repo.getCount()).toBe(0);
        });

        it("is idempotent on an already-empty table", async () => {
            await repo.truncate();
            expect(await repo.getCount()).toBe(0);
        });
    });

    // ---------------------------------------------------------------------------
    // Generation swap
    // ---------------------------------------------------------------------------

    describe("generation swap", () => {
        async function setState(generation: number): Promise<void> {
            await getTestDb().execute(sql`
                INSERT INTO osv_sync_state (id, affected_pkg_generation)
                VALUES (1, ${generation})
                ON CONFLICT (id) DO UPDATE SET affected_pkg_generation = ${generation}
            `);
        }

        async function rawCount(): Promise<number> {
            const rows = await getTestDb().execute<{ count: string }>(
                sql`SELECT COUNT(*)::int AS count FROM vulnerability_affected_packages`
            );
            return Number(rows[0]!.count);
        }

        it("defaults to generation 1 when no state row exists", async () => {
            expect(await repo.getCurrentGeneration()).toBe(1);
        });

        it("reads the pointer from osv_sync_state", async () => {
            await setState(7);
            expect(await repo.getCurrentGeneration()).toBe(7);
        });

        it("hides a generation that is being built from every read", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            await setState(1);

            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/live" })], 1);
            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/building" })], 2);

            // Both are in the table…
            expect(await rawCount()).toBe(2);
            // …but only the live generation is visible.
            expect(await repo.getCount()).toBe(1);
            expect(await findByPurl("pkg:npm/live")).toHaveLength(1);
            expect(await findByPurl("pkg:npm/building")).toHaveLength(0);
        });

        it("promotes the new generation and drops the superseded rows", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            await setState(1);

            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/live" })], 1);
            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/next" })], 2);

            const { deleted } = await repo.promoteGeneration(2);

            expect(deleted).toBe(1);
            expect(await repo.getCurrentGeneration()).toBe(2);
            expect(await rawCount()).toBe(1);
            expect(await findByPurl("pkg:npm/next")).toHaveLength(1);
            expect(await findByPurl("pkg:npm/live")).toHaveLength(0);
        });

        it("leaves the live generation untouched when a build is discarded", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            await setState(1);

            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/live" })], 1);
            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/abandoned" })], 2);

            expect(await repo.discardGeneration(2)).toBe(1);
            expect(await repo.getCount()).toBe(1);
            expect(await findByPurl("pkg:npm/live")).toHaveLength(1);
        });

        it("refuses to discard the live generation", async () => {
            await setState(3);
            await expect(repo.discardGeneration(3)).rejects.toThrow(/live/);
        });

        it("scopes replaceForVulns to one generation", async () => {
            const ids = await seedVulns("V-001");
            const id = ids.get("V-001")!;
            await setState(1);

            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/live" })], 1);
            await repo.bulkInsert([makeAffectedPkg(id, { purl: "pkg:npm/building" })], 2);

            // An incremental sync replacing this advisory in the live generation
            // must not delete the copy a rebuild has already written.
            const result = await repo.replaceForVulns(
                [id],
                [makeAffectedPkg(id, { purl: "pkg:npm/live-updated" })],
                1
            );

            expect(result.deleted).toBe(1);
            expect(await rawCount()).toBe(2);
            expect(await findByPurl("pkg:npm/live-updated")).toHaveLength(1);
        });
    });
});

/**
 * The Drizzle `CandidateStore` against a real PostgreSQL.
 *
 * The matching *rules* are unit-tested against an in-memory store; what is left
 * for a database is narrow, and it is exactly what an in-memory fake cannot
 * tell you:
 *
 *   - the SQL returns the right rows, grouped under the right keys;
 *   - withdrawn entries never leave the database;
 *   - a rebuild in flight is invisible — only the live generation is read;
 *   - release scoping narrows a distro key inside the database;
 *   - a key over the candidate cap is dropped rather than shipped;
 *   - and the batch lookup uses `vuln_affected_pkg_match_key_release_idx`.
 *
 * The last one is not pedantry. That index is partial on `withdrawn = false`,
 * so it is usable only while the query carries the same predicate. Someone
 * refactoring the withdrawn filter into application code would change no
 * result, break no behavioural test, and turn the hottest query in the system
 * into a sequential scan over ~1.2M rows. Only the plan shows it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../../src/db/schema/index.js";
import {
    candidateQuery,
    createDrizzleCandidateStore,
    oversizedKeysQuery,
} from "../../../src/matching/store.js";
import type { CandidateKey, CandidateStore } from "../../../src/matching/store.js";
import { cleanAllData, getTestDb, getTestPgClient } from "../../setup/test-db.js";
import { withFindingIdentity } from "../../fixtures/seed-data.js";

/**
 * Enough rows, with statistics, that the planner picks an index scan on its
 * own merits. Asserting the plan on a near-empty table would only prove that
 * `enable_seqscan = off` works.
 */
const FILLER_ROWS = 5_000;

let store: CandidateStore;

/** Keys with no release scoping — the language-ecosystem shape. */
function unscoped(...keys: string[]): CandidateKey[] {
    return keys.map((key) => ({ key, releases: null }));
}

beforeAll(() => {
    store = createDrizzleCandidateStore(getTestDb());
});

async function seedVulnerability(vulnId: string): Promise<string> {
    const db = getTestDb();
    const [vuln] = await db
        .insert(schema.vulnerabilities)
        .values(withFindingIdentity([{ vulnId, source: "osv", summary: `Summary for ${vulnId}` }]))
        .returning();

    return vuln!.id;
}

describe("Drizzle CandidateStore", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    // osv_sync_state is a single-row table that cleanAllData() does not touch,
    // and the generation test below writes to it. Leaving the row behind would
    // break the next suite that inserts id = 1.
    afterAll(async () => {
        await getTestDb().delete(schema.osvSyncState);
    });

    it("finds entries by match key and projects what the matcher needs", async () => {
        const db = getTestDb();
        const vulnerabilityId = await seedVulnerability("CVE-2024-0001");

        await db.insert(schema.vulnerabilityAffectedPackages).values({
            vulnerabilityId,
            matchKey: "apk/alpine|openssl",
            ecosystem: "Alpine:v3.23",
            ecosystemFamily: "Alpine",
            ecosystemRelease: "v3.23",
            packageName: "openssl",
            purl: "pkg:apk/alpine/openssl?arch=source",
            versions: ["3.5.5-r0"],
            ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "3.5.6-r0" }] }],
            fixedVersion: "3.5.6-r0",
        });

        const found = await store.findByKeys(unscoped("apk/alpine|openssl"));

        expect(found.get("apk/alpine|openssl")).toEqual([
            {
                vulnerabilityId,
                matchKey: "apk/alpine|openssl",
                ecosystem: "Alpine:v3.23",
                packageName: "openssl",
                versions: ["3.5.5-r0"],
                ranges: [
                    { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "3.5.6-r0" }] },
                ],
                fixedVersion: "3.5.6-r0",
                withdrawn: false,
            },
        ]);
    });

    it("groups a batch by key and omits keys with no entries", async () => {
        const db = getTestDb();
        const alpha = await seedVulnerability("CVE-2024-0002");
        const beta = await seedVulnerability("CVE-2024-0003");

        await db.insert(schema.vulnerabilityAffectedPackages).values([
            {
                vulnerabilityId: alpha,
                matchKey: "npm|lodash",
                ecosystem: "npm",
                packageName: "lodash",
            },
            {
                vulnerabilityId: beta,
                matchKey: "npm|lodash",
                ecosystem: "npm",
                packageName: "lodash",
            },
            {
                vulnerabilityId: beta,
                matchKey: "pypi|requests",
                ecosystem: "PyPI",
                packageName: "requests",
            },
        ]);

        const found = await store.findByKeys(unscoped("npm|lodash", "pypi|requests", "cargo|nothing-here"));

        expect([...found.keys()].sort()).toEqual(["npm|lodash", "pypi|requests"]);
        expect(found.get("npm|lodash")).toHaveLength(2);
        expect(found.get("pypi|requests")).toHaveLength(1);
    });

    it("tolerates duplicate keys in the request", async () => {
        const db = getTestDb();
        const vulnerabilityId = await seedVulnerability("CVE-2024-0004");

        await db.insert(schema.vulnerabilityAffectedPackages).values({
            vulnerabilityId,
            matchKey: "npm|lodash",
            ecosystem: "npm",
            packageName: "lodash",
        });

        const found = await store.findByKeys(unscoped("npm|lodash", "npm|lodash"));

        expect(found.get("npm|lodash")).toHaveLength(1);
    });

    it("never returns a withdrawn entry", async () => {
        const db = getTestDb();
        const active = await seedVulnerability("CVE-2024-0005");
        const retracted = await seedVulnerability("CVE-2024-0006");

        await db.insert(schema.vulnerabilityAffectedPackages).values([
            {
                vulnerabilityId: active,
                matchKey: "npm|lodash",
                ecosystem: "npm",
                packageName: "lodash",
                withdrawn: false,
            },
            {
                vulnerabilityId: retracted,
                matchKey: "npm|lodash",
                ecosystem: "npm",
                packageName: "lodash",
                withdrawn: true,
            },
        ]);

        const found = await store.findByKeys(unscoped("npm|lodash"));

        expect(found.get("npm|lodash")?.map((c) => c.vulnerabilityId)).toEqual([active]);
    });

    it("reads only the live generation, so a rebuild in flight is invisible", async () => {
        const db = getTestDb();
        const live = await seedVulnerability("CVE-2024-0008");
        const rebuilding = await seedVulnerability("CVE-2024-0009");

        // osv_sync_state is a single row shared by every suite and cleanAllData()
        // does not touch it, so claim it rather than assuming it is free.
        await db.delete(schema.osvSyncState);
        await db.insert(schema.osvSyncState).values({ id: 1, affectedPkgGeneration: 1 });
        await db.insert(schema.vulnerabilityAffectedPackages).values([
            {
                vulnerabilityId: live,
                matchKey: "npm|lodash",
                ecosystem: "npm",
                packageName: "lodash",
                generation: 1,
            },
            {
                // The same key, written by a bootstrap building the next generation.
                vulnerabilityId: rebuilding,
                matchKey: "npm|lodash",
                ecosystem: "npm",
                packageName: "lodash",
                generation: 2,
            },
        ]);

        const found = await store.findByKeys(unscoped("npm|lodash"));

        expect(found.get("npm|lodash")?.map((c) => c.vulnerabilityId)).toEqual([live]);
    });

    it("issues no query at all for an empty key set", async () => {
        const found = await store.findByKeys(unscoped());
        expect(found.size).toBe(0);
    });

    it("scopes a distro key to its release inside the database", async () => {
        const db = getTestDb();
        const vulnerabilityId = await seedVulnerability("CVE-2024-0010");

        const row = (ecosystem: string, releaseVersion: string | null, packageName = "linux") => ({
            vulnerabilityId,
            matchKey: "deb/ubuntu|linux",
            ecosystem,
            packageName,
            releaseVersion,
        });
        await db.insert(schema.vulnerabilityAffectedPackages).values([
            row("Ubuntu:22.04:LTS", "22.04"),
            row("Ubuntu:24.04:LTS", "24.04"),
            row("Ubuntu:Pro:18.04:LTS", "18.04"),
            // Names no release: applies to every one, so always returned.
            row("Ubuntu", null, "linux-unscoped"),
            // Predates the backfill: release unknown to SQL, admitted and
            // left to the matcher's in-memory check.
            row("Ubuntu:20.04:LTS", null, "linux-unbackfilled"),
        ]);

        const scoped = await store.findByKeys([{ key: "deb/ubuntu|linux", releases: ["22", "22.04"] }]);
        expect(scoped.get("deb/ubuntu|linux")?.map((c) => c.ecosystem).sort()).toEqual([
            "Ubuntu",
            "Ubuntu:20.04:LTS",
            "Ubuntu:22.04:LTS",
        ]);

        // A distro component that named no release: only the release-less rows.
        const releaseless = await store.findByKeys([{ key: "deb/ubuntu|linux", releases: [] }]);
        expect(releaseless.get("deb/ubuntu|linux")?.map((c) => c.ecosystem).sort()).toEqual([
            "Ubuntu",
            "Ubuntu:20.04:LTS",
        ]);

        // No scoping: everything, as before the column existed.
        const all = await store.findByKeys(unscoped("deb/ubuntu|linux"));
        expect(all.get("deb/ubuntu|linux")).toHaveLength(5);

        // The same key asked twice with different scopes is answered with the union.
        const union = await store.findByKeys([
            { key: "deb/ubuntu|linux", releases: ["22", "22.04"] },
            { key: "deb/ubuntu|linux", releases: ["24", "24.04"] },
        ]);
        expect(union.get("deb/ubuntu|linux")).toHaveLength(4);
    });

    it("drops a key over the candidate cap instead of returning it", async () => {
        const db = getTestDb();
        const vulnerabilityId = await seedVulnerability("CVE-2024-0011");
        const capped = createDrizzleCandidateStore(db, { maxCandidatesPerKey: 3 });

        await db.insert(schema.vulnerabilityAffectedPackages).values([
            ...Array.from({ length: 4 }, (_, i) => ({
                vulnerabilityId,
                matchKey: "deb/ubuntu|linux",
                ecosystem: "Ubuntu:22.04:LTS",
                releaseVersion: "22.04",
                packageName: `linux-${i}`,
            })),
            // Over the cap only before scoping: three rows for 22.04, three
            // for 24.04. Scoped to 22.04 it is within the cap and returned.
            ...Array.from({ length: 3 }, (_, i) => ({
                vulnerabilityId,
                matchKey: "deb/ubuntu|linux-gcp",
                ecosystem: "Ubuntu:22.04:LTS",
                releaseVersion: "22.04",
                packageName: `linux-gcp-${i}`,
            })),
            ...Array.from({ length: 3 }, (_, i) => ({
                vulnerabilityId,
                matchKey: "deb/ubuntu|linux-gcp",
                ecosystem: "Ubuntu:24.04:LTS",
                releaseVersion: "24.04",
                packageName: `linux-gcp-${i}`,
            })),
            { vulnerabilityId, matchKey: "npm|lodash", ecosystem: "npm", packageName: "lodash" },
        ]);

        const found = await capped.findByKeys([
            { key: "deb/ubuntu|linux", releases: ["22", "22.04"] },
            { key: "deb/ubuntu|linux-gcp", releases: ["22", "22.04"] },
            { key: "npm|lodash", releases: null },
        ]);

        expect(found.has("deb/ubuntu|linux")).toBe(false);
        expect(found.get("deb/ubuntu|linux-gcp")).toHaveLength(3);
        expect(found.get("npm|lodash")).toHaveLength(1);
    });

    it("uses the partial match_key index for the batch lookup", async () => {
        const db = getTestDb();
        const vulnerabilityId = await seedVulnerability("CVE-2024-0007");

        const filler = Array.from({ length: FILLER_ROWS }, (_, i) => ({
            vulnerabilityId,
            matchKey: `npm|filler-${i}`,
            ecosystem: "npm",
            packageName: `filler-${i}`,
        }));

        for (let i = 0; i < filler.length; i += 1_000) {
            await db
                .insert(schema.vulnerabilityAffectedPackages)
                .values(filler.slice(i, i + 1_000));
        }

        await db.execute("ANALYZE vulnerability_affected_packages");

        // The query the store actually issues, not a re-creation of it.
        const { sql: text, params } = candidateQuery(
            db,
            unscoped("npm|filler-1", "npm|filler-2")
        ).toSQL();

        const explained = await getTestPgClient().unsafe(
            `EXPLAIN ${text}`,
            params as (string | number | boolean)[]
        );
        const plan = explained.map((row) => String(row["QUERY PLAN"])).join("\n");

        expect(plan, plan).toContain("vuln_affected_pkg_match_key_release_idx");
        // Named, not bare "Seq Scan": the generation predicate resolves the live
        // pointer with a scalar subquery over the single-row osv_sync_state,
        // which the planner is right to read sequentially. What must never be
        // scanned is the mirror itself.
        expect(plan, plan).not.toContain("Seq Scan on vulnerability_affected_packages");

        // The scoped shape — two arms per release group plus an unscoped
        // arm — must also resolve to the index on both columns, and so must
        // the pre-flight count that guards the candidate cap.
        for (const query of [
            candidateQuery(db, [
                { key: "npm|filler-1", releases: null },
                { key: "deb/ubuntu|linux", releases: ["22", "22.04"] },
                { key: "deb/ubuntu|openssl", releases: [] },
            ]),
            oversizedKeysQuery(db, [{ key: "deb/ubuntu|linux", releases: ["22", "22.04"] }], 10),
        ]) {
            const scoped = query.toSQL();
            const scopedPlan = (
                await getTestPgClient().unsafe(
                    `EXPLAIN ${scoped.sql}`,
                    scoped.params as (string | number | boolean)[]
                )
            )
                .map((row) => String(row["QUERY PLAN"]))
                .join("\n");
            expect(scopedPlan, scopedPlan).toContain("vuln_affected_pkg_match_key_release_idx");
            expect(scopedPlan, scopedPlan).not.toContain("Seq Scan on vulnerability_affected_packages");
        }
    });
});

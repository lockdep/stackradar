/**
 * Migration 0024 re-keys the finding identities it backfills, and carries the
 * `finding_states` and finding-scope `issues` rows that key on them along.
 * Both tables are retired (no code reads or writes them since the issue
 * lifecycle was removed; they wait out a two-release deprecation), but the
 * migration still runs on a populated database and must leave what is there
 * consistent — so the test writes the rows directly.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";

let scenario: SeedTestScenarioResult;

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

async function identityOf(vulnId: string) {
    const [row] = await getTestDb()
        .select({ identity: schema.vulnerabilities.findingIdentity })
        .from(schema.vulnerabilities)
        .where(eq(schema.vulnerabilities.vulnId, vulnId));
    return row?.identity;
}

async function suppress(vulnIdentity: string, vulnId: string, packageName = "golang.org/x/net") {
    await getTestDb()
        .insert(schema.findingStates)
        .values({
            orgId: scenario.org.id,
            kind: "suppressed",
            packageType: "library",
            packageName,
            vulnIdentity,
            vulnId,
            createdByUserId: scenario.user.id,
            createdByEmail: scenario.user.email,
            reason: "not reachable",
            expiresAt: new Date("2027-01-01"),
        });
}

async function openIssue(vulnIdentity: string, vulnId: string, packageName = "golang.org/x/net") {
    const [issue] = await getTestDb()
        .insert(schema.issues)
        .values({
            orgId: scenario.org.id,
            clusterId: null,
            scope: "finding",
            packageType: "library",
            packageName,
            vulnIdentity,
            vulnId,
        })
        .returning();
    return issue!;
}

async function keyedIdentities() {
    const db = getTestDb();
    const states = await db.select({ identity: schema.findingStates.vulnIdentity }).from(schema.findingStates);
    const issues = await db
        .select({ identity: schema.issues.vulnIdentity, state: schema.issues.state })
        .from(schema.issues);
    return { states: states.map((s) => s.identity).sort(), issues };
}

describe("migration 0024 re-keys the identities it backfills", () => {
    it("moves #GO-… rows, suppressions and issues onto the GHSA identity", async () => {
        const db = getTestDb();
        // The pre-0024 state: each no-CVE record stands alone under its own id.
        await db.insert(schema.vulnerabilities).values([
            {
                vulnId: "GO-2026-6061",
                source: "osv",
                aliases: ["GHSA-hrxh-6v49-42gf"],
                findingIdentity: "#GO-2026-6061",
            },
            {
                vulnId: "GHSA-hrxh-6v49-42gf",
                source: "osv",
                aliases: ["GO-2026-6061"],
                findingIdentity: "#GHSA-hrxh-6v49-42gf",
            },
            {
                vulnId: "GO-2022-0197",
                source: "osv",
                aliases: ["CVE-2018-17847", "CVE-2018-17848", "GHSA-4r78-hx75-jjj2"],
                findingIdentity: "#GO-2022-0197",
            },
        ]);
        await suppress("#GO-2026-6061", "GO-2026-6061");
        await openIssue("#GO-2026-6061", "GO-2026-6061");

        const statements = readFileSync(
            new URL("../../../drizzle/0024_finding_identity_ghsa.sql", import.meta.url),
            "utf8",
        )
            .split("--> statement-breakpoint")
            .map((s) => s.trim())
            .filter(Boolean);
        // One connection: the migration's temp table is per-session.
        await db.transaction(async (tx) => {
            for (const statement of statements) await tx.execute(sql.raw(statement));
        });

        expect(await identityOf("GO-2026-6061")).toBe("#GHSA-hrxh-6v49-42gf");
        expect(await identityOf("GHSA-hrxh-6v49-42gf")).toBe("#GHSA-hrxh-6v49-42gf");
        expect(await identityOf("GO-2022-0197")).toBe("#GO-2022-0197");
        const keyed = await keyedIdentities();
        expect(keyed.states).toEqual(["#GHSA-hrxh-6v49-42gf"]);
        expect(keyed.issues).toEqual([{ identity: "#GHSA-hrxh-6v49-42gf", state: "open" }]);
    });
});

/**
 * What happens to suppressions and finding issues when a finding identity
 * moves — a GHSA published without a CVE, and the CVE landing a day later.
 *
 * `finding_states` and finding-scope `issues` key on the identity string.
 * The sync re-keys them in the upsert's transaction (`db/identity-rekey.ts`),
 * migration 0024 re-keys the identities it backfills, and the verify sweep
 * refuses to call a finding fixed while a record that still names it is
 * counted (`findingIssuesStillNamed`).
 *
 * Dynamic imports so `db/index.ts` initialises after test setup has set
 * DATABASE_URL.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createSbom,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

type VulnRepository = typeof import("../../../src/repositories/index.js").vulnerabilityRepository;
type Service = typeof import("../../../src/services/remediation.service.js");
type Parser = typeof import("../../../src/osv-sync/parser.js");

let vulnerabilityRepository: VulnRepository;
let verifyFindingIssues: Service["verifyFindingIssues"];
let parser: Parser;

beforeAll(async () => {
    vulnerabilityRepository = (await import("../../../src/repositories/index.js")).vulnerabilityRepository;
    verifyFindingIssues = (await import("../../../src/services/remediation.service.js")).verifyFindingIssues;
    parser = await import("../../../src/osv-sync/parser.js");
});

let scenario: SeedTestScenarioResult;

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

/** The real sync write path: parse an OSV record, convert it, upsert it. */
async function sync(vulnId: string, aliases: string[], modified: string) {
    const bytes = Buffer.from(JSON.stringify({ id: vulnId, modified, aliases }));
    const record = parser.parseOsvJson(bytes, "test", (b) => createHash("sha256").update(b).digest());
    await vulnerabilityRepository.bulkUpsertFromSync([parser.convertOsvRecordToVulnerability(record)]);
}

async function identityOf(vulnId: string) {
    const [row] = await getTestDb()
        .select({ identity: schema.vulnerabilities.findingIdentity })
        .from(schema.vulnerabilities)
        .where(eq(schema.vulnerabilities.vulnId, vulnId));
    return row?.identity;
}

async function suppress(vulnIdentity: string, vulnId: string, packageName = "golang.org/x/net") {
    await getTestDb().insert(schema.findingStates).values({
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
    const issues = await db.select({ identity: schema.issues.vulnIdentity, state: schema.issues.state }).from(schema.issues);
    return { states: states.map((s) => s.identity).sort(), issues };
}

describe("the sync re-keys suppressions and issues when an identity moves", () => {
    it("follows the GHSA when GitHub adds the CVE", async () => {
        await sync("GHSA-hrxh-6v49-42gf", ["GO-2026-6061"], "2026-09-01T00:00:00Z");
        await sync("GO-2026-6061", ["GHSA-hrxh-6v49-42gf"], "2026-09-01T00:00:00Z");
        expect(await identityOf("GO-2026-6061")).toBe("#GHSA-hrxh-6v49-42gf");
        await suppress("#GHSA-hrxh-6v49-42gf", "GHSA-hrxh-6v49-42gf");
        await openIssue("#GHSA-hrxh-6v49-42gf", "GHSA-hrxh-6v49-42gf", "google.golang.org/grpc");

        // A day later the GHSA gains its CVE: the namesake moves, the keyed rows follow.
        await sync("GHSA-hrxh-6v49-42gf", ["GO-2026-6061", "CVE-2026-7777"], "2026-09-02T00:00:00Z");

        const keyed = await keyedIdentities();
        expect(keyed.states).toEqual(["CVE-2026-7777"]);
        expect(keyed.issues).toEqual([{ identity: "CVE-2026-7777", state: "open" }]);
    });

    it("moves each row with the advisory it was written against, not its neighbours", async () => {
        await sync("GHSA-hrxh-6v49-42gf", ["GO-2026-6061"], "2026-09-01T00:00:00Z");
        await sync("GO-2026-6061", ["GHSA-hrxh-6v49-42gf"], "2026-09-01T00:00:00Z");
        // Same identity, acted on through two different advisories.
        await suppress("#GHSA-hrxh-6v49-42gf", "GHSA-hrxh-6v49-42gf", "golang.org/x/net");
        await suppress("#GHSA-hrxh-6v49-42gf", "GO-2026-6061", "google.golang.org/grpc");

        // The Go record gets its CVE first: only the row written against it moves.
        await sync("GO-2026-6061", ["GHSA-hrxh-6v49-42gf", "CVE-2026-7777"], "2026-09-02T00:00:00Z");
        expect((await keyedIdentities()).states).toEqual(["#GHSA-hrxh-6v49-42gf", "CVE-2026-7777"]);

        // Then the GHSA catches up, and the other follows.
        await sync("GHSA-hrxh-6v49-42gf", ["GO-2026-6061", "CVE-2026-7777"], "2026-09-03T00:00:00Z");
        expect((await keyedIdentities()).states).toEqual(["CVE-2026-7777", "CVE-2026-7777"]);
    });

    it("keeps an existing suppression under the new identity and drops the dead one", async () => {
        await sync("GHSA-aaaa-bbbb-cccc", [], "2026-09-01T00:00:00Z");
        await suppress("#GHSA-aaaa-bbbb-cccc", "GHSA-aaaa-bbbb-cccc");
        await suppress("CVE-2026-8888", "CVE-2026-8888");

        await sync("GHSA-aaaa-bbbb-cccc", ["CVE-2026-8888"], "2026-09-02T00:00:00Z");

        const states = await getTestDb().select().from(schema.findingStates);
        expect(states).toHaveLength(1);
        expect(states[0]).toMatchObject({ vulnIdentity: "CVE-2026-8888", vulnId: "CVE-2026-8888" });
    });

    it("does not drag a CVE's rows away when one record's alias is corrected off it", async () => {
        await sync("CVE-2026-1111", [], "2026-09-01T00:00:00Z");
        await sync("GHSA-dddd-eeee-ffff", ["CVE-2026-1111"], "2026-09-01T00:00:00Z");
        await suppress("CVE-2026-1111", "CVE-2026-1111");

        await sync("GHSA-dddd-eeee-ffff", ["CVE-2026-2222"], "2026-09-02T00:00:00Z");

        expect((await keyedIdentities()).states).toEqual(["CVE-2026-1111"]);
    });

    it("follows its own advisory when a CVE with no record of its own is withdrawn from it", async () => {
        // No `CVE-2026-3333` record in the mirror: two advisories name it.
        await sync("GHSA-gggg-hhhh-iiii", ["CVE-2026-3333"], "2026-09-01T00:00:00Z");
        await sync("GO-2026-0001", ["CVE-2026-3333"], "2026-09-01T00:00:00Z");
        await suppress("CVE-2026-3333", "GHSA-gggg-hhhh-iiii");

        // The GO record drops the CVE: not the advisory the suppression was placed on.
        await sync("GO-2026-0001", [], "2026-09-02T00:00:00Z");
        expect((await keyedIdentities()).states).toEqual(["CVE-2026-3333"]);

        // The GHSA drops it too: the suppression goes where the GHSA went.
        await sync("GHSA-gggg-hhhh-iiii", [], "2026-09-03T00:00:00Z");
        expect((await keyedIdentities()).states).toEqual(["#GHSA-gggg-hhhh-iiii"]);
    });
});

describe("migration 0024 re-keys the identities it backfills", () => {
    it("moves #GO-… rows, suppressions and issues onto the GHSA identity", async () => {
        const db = getTestDb();
        // The pre-0024 state: each no-CVE record stands alone under its own id.
        await db.insert(schema.vulnerabilities).values([
            { vulnId: "GO-2026-6061", source: "osv", aliases: ["GHSA-hrxh-6v49-42gf"], findingIdentity: "#GO-2026-6061" },
            { vulnId: "GHSA-hrxh-6v49-42gf", source: "osv", aliases: ["GO-2026-6061"], findingIdentity: "#GHSA-hrxh-6v49-42gf" },
            { vulnId: "GO-2022-0197", source: "osv", aliases: ["CVE-2018-17847", "CVE-2018-17848", "GHSA-4r78-hx75-jjj2"], findingIdentity: "#GO-2022-0197" },
        ]);
        await suppress("#GO-2026-6061", "GO-2026-6061");
        await openIssue("#GO-2026-6061", "GO-2026-6061");

        const statements = readFileSync(new URL("../../../drizzle/0024_finding_identity_ghsa.sql", import.meta.url), "utf8")
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

describe("the verify sweep does not call a renamed finding fixed", () => {
    /** A running image whose `golang.org/x/net` matched `vulnId`. */
    async function seedFinding(vulnId: string, aliases: string[], findingIdentity: string) {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, scenario.org.id, scenario.cluster.id, { workloadName: "api" });
        const sbom = await createSbom(db, { imageId: image.id });
        const [component] = await db
            .insert(schema.components)
            .values({
                sbomId: sbom.id,
                name: "golang.org/x/net",
                version: "0.26.0",
                purl: "pkg:golang/golang.org/x/net@0.26.0",
                type: "library",
                isDirect: true,
            })
            .returning();
        const [vuln] = await db
            .insert(schema.vulnerabilities)
            .values({ vulnId, source: "osv", aliases, findingIdentity })
            .returning();
        await db.insert(schema.componentVulnerabilities).values({
            componentId: component!.id,
            vulnerabilityId: vuln!.id,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: "exact",
        });
    }

    it("keeps the issue open while the matched record still names its advisory", async () => {
        // The Go record moved to the CVE first; the issue is still on the GHSA's identity.
        await seedFinding("GO-2026-6061", ["GHSA-hrxh-6v49-42gf", "CVE-2026-7777"], "CVE-2026-7777");
        await openIssue("#GHSA-hrxh-6v49-42gf", "GHSA-hrxh-6v49-42gf");

        expect(await verifyFindingIssues(scenario.org.id)).toBe(0);
        expect((await keyedIdentities()).issues).toEqual([{ identity: "#GHSA-hrxh-6v49-42gf", state: "open" }]);
    });

    it("still verifies when nothing on the package names it", async () => {
        await seedFinding("GO-2026-9999", ["GHSA-zzzz-yyyy-xxxx"], "#GHSA-zzzz-yyyy-xxxx");
        await openIssue("#GHSA-hrxh-6v49-42gf", "GHSA-hrxh-6v49-42gf");

        expect(await verifyFindingIssues(scenario.org.id)).toBe(1);
    });
});

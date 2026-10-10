import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { runTierReclassifyJob } from "../../../src/services/tier-rules.service.js";
import { seedTestScenario, createUser, addOrgMember, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";

/**
 * An org's override rules for the component classifier (component tier plan,
 * item 9): applied after the built-in rules at ingest and by the org-scoped
 * reclassification, audited, admin-only — and never suppression.
 */
describe("component tier rules", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    const headers = (user = testData.user) =>
        createInternalHeaders({ id: user.id, email: user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug });
    const url = () => `/api/organizations/${testData.org.id}/tier-rules`;

    const npm = (name: string, path: string) => ({
        type: "library",
        name,
        version: "1.0.0",
        purl: `pkg:npm/${name.replace("@", "%40")}@1.0.0`,
        "bom-ref": name,
        properties: [
            { name: "syft:package:type", value: "npm" },
            { name: "syft:location:0:path", value: path },
        ],
    });
    const SBOM = {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        components: [
            // Built-in rule 3 calls this runtime tooling: it sits in node's global modules.
            npm("@mycorp/cli", "/usr/local/lib/node_modules/@mycorp/cli/package.json"),
            npm("lodash", "/app/node_modules/lodash/package.json"),
        ],
    };

    async function upload(suffix: string) {
        const res = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=sha256:${suffix.padStart(64, "0")}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(SBOM)
            .expect(201);
        return res.body.id as string;
    }

    async function tiers(sbomId: string) {
        const rows = await getTestDb()
            .select({ name: schema.components.name, tier: schema.components.tier })
            .from(schema.components)
            .where(eq(schema.components.sbomId, sbomId));
        return Object.fromEntries(rows.map((r) => [r.name, r.tier]));
    }

    it("moves matching components after the scoped reclassification, and applies at the next ingest", async () => {
        const before = await upload("f1");
        expect(await tiers(before)).toEqual({ "@mycorp/cli": "runtime", lodash: "application" });

        const created = await request(app)
            .post(url())
            .set(headers())
            .send({ matchKind: "purl-prefix", pattern: "pkg:npm/%40mycorp/", tier: "application", reason: "our own tooling" });
        expect(created.status).toBe(201);
        expect(created.body.rule).toMatchObject({ matchKind: "purl-prefix", tier: "application", componentsTouched: 1 });

        // The rule queued exactly one job for this org; run it as the worker would.
        const jobs = await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.type, "tier_reclassify"));
        expect(jobs).toHaveLength(1);
        const result = await runTierReclassifyJob(testData.org.id);
        expect(result["components"]).toBe(2);
        expect(await tiers(before)).toEqual({ "@mycorp/cli": "application", lodash: "application" });

        // A new upload is classified with the rule already in force.
        expect(await tiers(await upload("f2"))).toEqual({ "@mycorp/cli": "application", lodash: "application" });

        // Removing it puts the built-in verdict back.
        const removed = await request(app).delete(`${url()}/${created.body.rule.id}`).set(headers());
        expect(removed.status).toBe(204);
        await runTierReclassifyJob(testData.org.id);
        expect(await tiers(before)).toEqual({ "@mycorp/cli": "runtime", lodash: "application" });
    });

    it("writes an audit event for every rule change", async () => {
        const created = await request(app).post(url()).set(headers()).send({ matchKind: "name", pattern: "lodash", tier: "os" });
        await request(app).delete(`${url()}/${created.body.rule.id}`).set(headers());
        const events = await getTestDb()
            .select({ type: schema.activityEvents.type, payload: schema.activityEvents.payload })
            .from(schema.activityEvents)
            .where(inArray(schema.activityEvents.type, ["tier-rule.created", "tier-rule.removed"]));
        expect(events.map((e) => e.type).sort()).toEqual(["tier-rule.created", "tier-rule.removed"]);
        expect(events[0]!.payload).toMatchObject({ pattern: "lodash", byEmail: testData.user.email });
    });

    it("refuses members, duplicates, and a pattern short enough to match everything", async () => {
        const member = await createUser(getTestDb(), { email: "member-rules@example.com" });
        await addOrgMember(getTestDb(), member.id, testData.org.id, "member");
        expect((await request(app).get(url()).set(headers(member))).status).toBe(403);
        expect((await request(app).post(url()).set(headers(member)).send({ matchKind: "name", pattern: "lodash", tier: "os" })).status).toBe(403);

        expect((await request(app).post(url()).set(headers()).send({ matchKind: "purl-prefix", pattern: "pk", tier: "os" })).status).toBe(400);
        expect((await request(app).post(url()).set(headers()).send({ matchKind: "name", pattern: "lodash", tier: "unknown" })).status).toBe(400);

        expect((await request(app).post(url()).set(headers()).send({ matchKind: "name", pattern: "lodash", tier: "os" })).status).toBe(201);
        expect((await request(app).post(url()).set(headers()).send({ matchKind: "name", pattern: "lodash", tier: "runtime" })).status).toBe(409);
    });

    it("stores the org's default findings view", async () => {
        const res = await request(app).patch(`/api/organizations/${testData.org.id}`).set(headers()).send({ defaultFindingTier: "all" });
        expect(res.status).toBe(200);
        expect(res.body.organization.defaultFindingTier).toBe("all");
        const bad = await request(app).patch(`/api/organizations/${testData.org.id}`).set(headers()).send({ defaultFindingTier: "base" });
        expect(bad.status).toBe(400);
    });
});

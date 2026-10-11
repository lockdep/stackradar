import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import postgres from "postgres";
import { TIER_VERSION } from "../../../src/lib/component-tier.js";
import { backfillComponentTier } from "../../../src/lib/component-tier-backfill.js";

/**
 * `components.tier` is written at ingest (component tier plan, item 1): the
 * classifier sees the same property list that lands in
 * `component_properties`, so a fresh upload needs no backfill.
 */
describe("SBOM upload — component tier", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    async function upload(digestSuffix: string, body: object): Promise<string> {
        const digest = `sha256:${digestSuffix.padStart(64, "0")}`;
        const res = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(body)
            .expect(201);
        return res.body.id as string;
    }

    async function histogram(sbomId: string): Promise<Record<string, number>> {
        const rows = await getTestDb()
            .select({ tier: schema.components.tier, n: sql<number>`count(*)::int` })
            .from(schema.components)
            .where(eq(schema.components.sbomId, sbomId))
            .groupBy(schema.components.tier);
        return Object.fromEntries(rows.map((r) => [r.tier, r.n]));
    }

    it("classifies the alpine fixture's 15 apk packages as os", async () => {
        const alpine = JSON.parse(
            readFileSync(new URL("../../fixtures/sboms/alpine-3.19.cdx.json", import.meta.url), "utf8"),
        );
        const sbomId = await upload("a1", alpine);

        const tiers = await histogram(sbomId);
        expect(tiers.os).toBe(15);
        expect(tiers.application ?? 0).toBe(0);

        const versions = await getTestDb()
            .selectDistinct({ v: schema.components.tierVersion })
            .from(schema.components)
            .where(eq(schema.components.sbomId, sbomId));
        expect(versions).toEqual([{ v: TIER_VERSION }]);
    });

    it("splits a node image into runtime tooling and application dependencies", async () => {
        const npm = (name: string, path: string) => ({
            type: "library",
            name,
            version: "1.0.0",
            purl: `pkg:npm/${name}@1.0.0`,
            "bom-ref": `${name}-${path}`,
            properties: [
                { name: "syft:package:type", value: "npm" },
                { name: "syft:location:0:path", value: path },
            ],
        });
        const sbomId = await upload("a2", {
            bomFormat: "CycloneDX",
            specVersion: "1.6",
            version: 1,
            components: [
                npm("npm", "/usr/local/lib/node_modules/npm/package.json"),
                npm("semver", "/usr/local/lib/node_modules/npm/node_modules/semver/package.json"),
                npm("express", "/app/node_modules/express/package.json"),
                npm("lodash", "/app/node_modules/lodash/package.json"),
            ],
        });

        const rows = await getTestDb()
            .select({ name: schema.components.name, tier: schema.components.tier })
            .from(schema.components)
            .where(eq(schema.components.sbomId, sbomId));
        const byName = Object.fromEntries(rows.map((r) => [r.name, r.tier]));
        expect(byName).toEqual({
            npm: "runtime",
            semver: "runtime",
            express: "application",
            lodash: "application",
        });
    });
});

describe("backfillComponentTier", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    it("re-classifies stale rows from stored properties, and is idempotent", async () => {
        const alpine = JSON.parse(
            readFileSync(new URL("../../fixtures/sboms/alpine-3.19.cdx.json", import.meta.url), "utf8"),
        );
        await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=sha256:${"b1".padStart(64, "0")}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(alpine)
            .expect(201);

        // What a row ingested before the column existed looks like.
        await getTestDb().update(schema.components).set({ tier: "unknown", tierVersion: 0 });

        const sqlClient = postgres(process.env.DATABASE_URL!, { max: 1 });
        try {
            const dry = await backfillComponentTier(sqlClient, { dryRun: true });
            expect(dry.histogram.os).toBe(15);
            const untouched = await sqlClient<{ n: number }[]>`
                SELECT count(*)::int AS n FROM components WHERE tier_version = 0`;
            expect(untouched[0]?.n).toBe(dry.components);

            const first = await backfillComponentTier(sqlClient);
            expect(first.histogram.os).toBe(15);
            expect(first.unknownShareOfPackages).toBe(0);

            const second = await backfillComponentTier(sqlClient);
            expect(second.components).toBe(0);
        } finally {
            await sqlClient.end();
        }

        const [row] = await getTestDb()
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.components)
            .where(eq(schema.components.tier, "os"));
        expect(row!.n).toBe(15);
    });
});

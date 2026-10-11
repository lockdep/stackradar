/**
 * The gate that keeps "the public number is the product number" true.
 *
 * One SBOM goes through the ordinary ingest and the ordinary scan job, and
 * the product's own `collapsedFindings` is read for the image. The same
 * components go to `POST /internal/match`. The two answers must be the same
 * set of `(purlType, packageName, findingIdentity)`, with the same risk,
 * fixed version and KEV date per key. If this fails, the endpoint is wrong,
 * not the product.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// `vi.hoisted` runs before the imports below are evaluated. That matters
// because `config` snapshots `process.env` once at import and the fixtures
// (`seed-data` → `api-key-vault`) pull it in transitively, so a plain
// top-level assignment would land after the snapshot and be ignored.
vi.hoisted(() => {
    process.env.MATCH_SERVICE_KEY = "test-match-key";
});
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { parsePurl } from "../../../src/matching/index.js";
import { EXPECTED_FINDING_KEYS, MIRROR_COMPONENTS, mirrorCycloneDx, seedMatchMirror } from "./mirror-fixture.js";

// Loaded after the database is pointed at the test container (see
// finding-definition.test.ts for why).
async function productFindings(imageId: string) {
    const { collapsedFindings } = await import("../../../src/db/findings.js");
    const db = getTestDb();
    const findings = collapsedFindings(eq(schema.images.id, imageId));
    const rows = await db
        .select({
            componentId: findings.componentId,
            packageName: findings.packageName,
            identity: findings.identity,
            riskScore: findings.riskScore,
            fixedVersion: findings.fixedVersion,
            kevListedAt: findings.kevListedAt,
            purl: schema.components.purl,
        })
        .from(findings)
        .innerJoin(schema.components, eq(schema.components.id, findings.componentId));
    return rows;
}

type Keyed = { risk: number; fixedVersion: string | null; kevListedAt: string | null };

let app: Express;
let scenario: SeedTestScenarioResult;

beforeAll(async () => {
    app = await getTestApp();
});

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
    await seedMatchMirror(getTestDb());
});

describe("POST /internal/match parity with collapsedFindings", () => {
    it("returns the same findings, risk, fix and KEV date as the product's scan", async () => {
        const db = getTestDb();

        // 1. The product path: upload, then run the scan job it queued.
        const upload = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=sha256:${"a".repeat(64)}`)
            .set(createApiKeyHeaders(scenario.apiKey.rawKey))
            .send(mirrorCycloneDx());
        expect(upload.status).toBe(201);
        const imageId: string = upload.body.imageId;

        const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.type, "vulnerability_scan"));
        expect(job).toBeDefined();
        const { jobService } = await import("../../../src/services/job.service.js");
        await jobService.executeJob(job!);

        const product = new Map<string, Keyed>();
        for (const row of await productFindings(imageId)) {
            const key = `${parsePurl(row.purl)?.type ?? null}|${row.packageName}|${row.identity}`;
            product.set(key, {
                risk: row.riskScore ?? 0,
                fixedVersion: row.fixedVersion,
                kevListedAt: row.kevListedAt?.toISOString() ?? null,
            });
        }

        // 2. The endpoint, over the same components.
        const res = await request(app)
            .post("/internal/match")
            .set({ "X-Match-Key": "test-match-key" })
            .send({ components: MIRROR_COMPONENTS });
        expect(res.status).toBe(200);

        const endpoint = new Map<string, Keyed>();
        for (const f of res.body.findings as {
            purlType: string | null;
            packageName: string;
            findingIdentity: string;
            risk: number;
            fixedVersion: string | null;
            kevListedAt: string | null;
        }[]) {
            endpoint.set(`${f.purlType}|${f.packageName}|${f.findingIdentity}`, {
                risk: f.risk,
                fixedVersion: f.fixedVersion,
                kevListedAt: f.kevListedAt,
            });
        }

        // Non-trivial first: agreeing on the empty set would also pass.
        expect([...product.keys()].sort()).toEqual(EXPECTED_FINDING_KEYS);
        expect([...endpoint.keys()].sort()).toEqual([...product.keys()].sort());

        for (const [key, expected] of product) {
            expect(endpoint.get(key), key).toEqual(expected);
        }
    });
});

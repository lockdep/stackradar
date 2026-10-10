import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { parseImageMetadata } from "../../../src/lib/image-layers.js";
import { recordKnownChains, resolveBaseForImage } from "../../../src/services/base-image.service.js";

/**
 * The base-image boundary through the real ingest (component tier plan,
 * item 6): `images.base_*`, `components.from_base`, and the lens bucket that
 * follows provenance once it is known.
 *
 * `nginx:1.27-alpine` names its base on its manifest
 * (`nginx:1.27.5-alpine-slim`). The test supplies that base's chain as a
 * known public image of **6** layers — a number chosen for the test, not
 * measured — so everything in layers 0–5 is the base's.
 */
const NGINX = JSON.parse(
    readFileSync(new URL("../../fixtures/nginx-1.27-alpine.deep-squashed.cdx.json", import.meta.url), "utf8")
) as Record<string, unknown>;
const CHAIN = parseImageMetadata(NGINX).layers.filter((l) => l.diffId !== null).map((l) => l.diffId!);
const BASE_DEPTH = 6;

describe("SBOM upload — base image boundary", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        await getTestDb().delete(schema.knownLayerPrefixes);
        testData = await seedTestScenario(getTestDb());
    });

    async function upload(suffix: string, scannerVersion: string): Promise<{ sbomId: string; imageId: string }> {
        const res = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=sha256:${suffix.padStart(64, "0")}`)
            .set({ ...createApiKeyHeaders(testData.apiKey.rawKey), "X-Scanner-Version": scannerVersion })
            .send(NGINX)
            .expect(201);
        return { sbomId: res.body.id, imageId: res.body.imageId };
    }

    const imageRow = async (imageId: string) =>
        (await getTestDb().select().from(schema.images).where(eq(schema.images.id, imageId)))[0]!;

    async function fromBaseHistogram(sbomId: string) {
        const rows = await getTestDb()
            .select({ fromBase: schema.components.fromBase, n: sql<number>`count(*)::int` })
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), eq(schema.components.tier, "os")))
            .groupBy(schema.components.fromBase);
        return Object.fromEntries(rows.map((r) => [String(r.fromBase), r.n]));
    }

    it("names the base from the annotation before anyone has counted its layers", async () => {
        const { imageId, sbomId } = await upload("e1", "0.4.0");
        expect(await imageRow(imageId)).toMatchObject({
            baseImageRef: "nginx:1.27.5-alpine-slim",
            baseLayerCount: null,
            baseDetectedBy: "annotation",
        });
        // No count, no boundary: every component's from_base stays null and the tier stands in.
        expect(await fromBaseHistogram(sbomId)).toEqual({ null: 68 });
    });

    it("counts the named base once its chain is known, and cuts from_base there", async () => {
        await recordKnownChains([{ imageRef: "docker.io/library/nginx:1.27.5-alpine-slim", diffIds: CHAIN.slice(0, BASE_DEPTH) }], "registry");
        const { imageId, sbomId } = await upload("e2", "0.4.0");

        expect(await imageRow(imageId)).toMatchObject({
            baseImageRef: "nginx:1.27.5-alpine-slim",
            baseLayerCount: BASE_DEPTH,
            baseDetectedBy: "annotation",
        });
        const histogram = await fromBaseHistogram(sbomId);
        expect(histogram["null"]).toBeUndefined();
        expect(histogram["true"]).toBeGreaterThanOrEqual(15);
        expect((histogram["true"] ?? 0) + (histogram["false"] ?? 0)).toBe(68);
    });

    it("does not trust an OS package's layer from a scanner older than deep-squashed", async () => {
        await recordKnownChains([{ imageRef: "nginx:1.27.5-alpine-slim", diffIds: CHAIN.slice(0, BASE_DEPTH) }], "registry");
        const { sbomId } = await upload("e3", "0.3.0");
        expect(await fromBaseHistogram(sbomId)).toEqual({ null: 68 });
    });

    it("is picked up later, when the chain becomes known after the upload", async () => {
        const { imageId, sbomId } = await upload("e4", "0.4.0");
        await recordKnownChains([{ imageRef: "nginx:1.27.5-alpine-slim", diffIds: CHAIN.slice(0, BASE_DEPTH) }], "registry");
        const verdict = await resolveBaseForImage(imageId);
        expect(verdict).toMatchObject({ baseLayerCount: BASE_DEPTH });
        expect((await fromBaseHistogram(sbomId))["null"]).toBeUndefined();
    });

    it("lets provenance decide the lens bucket: an OS package in the customer's own layer is theirs", async () => {
        await recordKnownChains([{ imageRef: "nginx:1.27.5-alpine-slim", diffIds: CHAIN.slice(0, 1) }], "registry");
        const { imageId, sbomId } = await upload("e5", "0.4.0");
        const db = getTestDb();

        // A finding on an apk package that lives above the (one-layer) base.
        const [above] = await db
            .select({ id: schema.components.id })
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), eq(schema.components.tier, "os"), eq(schema.components.fromBase, false)))
            .limit(1);
        expect(above).toBeDefined();
        const [vuln] = await db
            .insert(schema.vulnerabilities)
            .values({ vulnId: "CVE-2026-9001", source: "osv", severityLevel: "high", cvssScore: 7.5, epssScore: 0.001, findingIdentity: "CVE-2026-9001" })
            .returning();
        await db.insert(schema.componentVulnerabilities).values({
            componentId: above!.id, vulnerabilityId: vuln!.id, matchedBy: "purl", matchType: "direct", matchConfidence: "exact",
        });

        const headers = createInternalHeaders({
            id: testData.user.id, email: testData.user.email,
            orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug,
        });
        const res = await request(app).get(`/api/images/${imageId}/vulnerabilities/grouped?tier=application,main`).set(headers);
        expect(res.status).toBe(200);
        expect(res.body.tierCounts).toEqual({ application: 1, base: 0, all: 1 });
        expect(res.body.groups).toHaveLength(1);
        expect(res.body.groups[0]).toMatchObject({ fromBase: false });
        expect(typeof res.body.groups[0].layerCreatedBy).toBe("string");
    });
});


import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { validateCycloneDx } from "../../../src/validators/cyclonedx.validator.js";

/**
 * The image metadata a scanner ≥ 0.4.0 sends on the upload (component tier
 * plan, item 5): `image_layers`, `images.metadata`, `components.layer_index`.
 *
 * The fixture is `nginx:1.27-alpine` as syft 1.42.1 wrote it under
 * `--scope deep-squashed`, with the `stackradar:*` properties attached by the
 * scanner's own `attachImageMetadata` — `file` components and the dependency
 * graph dropped to keep it small. 2026-09-17; re-measure if the tag has moved.
 */
const NGINX = JSON.parse(
    readFileSync(new URL("../../fixtures/nginx-1.27-alpine.deep-squashed.cdx.json", import.meta.url), "utf8")
) as Record<string, unknown>;

describe("SBOM upload — image layers", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    async function upload(suffix: string, body: object, query = ""): Promise<{ sbomId: string; imageId: string }> {
        const digest = `sha256:${suffix.padStart(64, "0")}`;
        const res = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}${query}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(body)
            .expect(201);
        return { sbomId: res.body.id, imageId: res.body.imageId };
    }

    it("accepts properties on metadata.component — they are valid CycloneDX 1.6", () => {
        expect(validateCycloneDx(NGINX)).toMatchObject({ valid: true });
    });

    it("stores the layers in order, and the image facts", async () => {
        const { imageId } = await upload("c1", NGINX);
        const db = getTestDb();

        const layers = await db
            .select()
            .from(schema.imageLayers)
            .where(eq(schema.imageLayers.imageId, imageId))
            .orderBy(asc(schema.imageLayers.index));
        expect(layers).toHaveLength(19);
        expect(layers.map((l) => l.index)).toEqual([...Array(19).keys()]);
        const real = layers.filter((l) => !l.emptyLayer);
        expect(real.map((l) => l.rootfsIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(layers[0]).toMatchObject({ rootfsIndex: 0, emptyLayer: false, source: "scanner" });
        expect(layers[0]!.createdBy).toContain("ADD alpine-minirootfs");
        expect(layers[1]).toMatchObject({ emptyLayer: true, diffId: null, rootfsIndex: null });

        const [image] = await db.select().from(schema.images).where(eq(schema.images.id, imageId));
        expect(image!.metadata).toMatchObject({
            baseName: "nginx:1.27.5-alpine-slim",
            official: "true",
            entrypoint: "/docker-entrypoint.sh",
            cmd: "nginx",
            "env:NGINX_VERSION": "1.27.5",
        });
    });

    it("attributes exactly 15 apk packages to the base layer", async () => {
        const { sbomId } = await upload("c2", NGINX);
        const rows = await getTestDb()
            .select({ layerIndex: schema.components.layerIndex, n: sql<number>`count(*)::int` })
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), eq(schema.components.tier, "os")))
            .groupBy(schema.components.layerIndex);
        const byLayer = Object.fromEntries(rows.map((r) => [String(r.layerIndex), r.n]));

        expect(byLayer["0"]).toBe(15);
        expect(byLayer["null"]).toBeUndefined();
        expect(rows.reduce((n, r) => n + r.n, 0)).toBe(68);
    });

    it("still ingests an upload with no layer properties, with a null layer_index", async () => {
        const plain = structuredClone(NGINX) as { metadata: { component: { properties?: unknown } } };
        delete plain.metadata.component.properties;
        const { sbomId, imageId } = await upload("c3", plain);
        const db = getTestDb();

        expect(await db.select().from(schema.imageLayers).where(eq(schema.imageLayers.imageId, imageId))).toEqual([]);
        const resolved = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), sql`${schema.components.layerIndex} IS NOT NULL`));
        expect(resolved[0]!.n).toBe(0);
    });

    it("keeps the image's layers when a re-upload brings none, and resolves against them", async () => {
        const { imageId } = await upload("c4", NGINX);
        const plain = structuredClone(NGINX) as { metadata: { component: { properties?: unknown } } };
        delete plain.metadata.component.properties;
        const { sbomId } = await upload("c4", plain, "&replace=true");
        const db = getTestDb();

        expect(await db.select().from(schema.imageLayers).where(eq(schema.imageLayers.imageId, imageId))).toHaveLength(19);
        const base = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, sbomId), eq(schema.components.tier, "os"), eq(schema.components.layerIndex, 0)));
        expect(base[0]!.n).toBe(15);
    });
});

describe("resolveStoredLayerIndexes — the backfill's SQL twin of resolveLayerIndex", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    it("fills layer_index for an SBOM ingested before its image had layers", async () => {
        const { parseImageMetadata } = await import("../../../src/lib/image-layers.js");
        const { imageLayerRepository } = await import("../../../src/repositories/index.js");
        const { resolveStoredLayerIndexes } = await import("../../../src/services/image-layer-backfill.service.js");

        // As a scanner < 0.4.0 would have sent it: packages with layer ids, no layer list.
        const plain = structuredClone(NGINX) as { metadata: { component: { properties?: unknown } } };
        delete plain.metadata.component.properties;
        const res = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=sha256:${"d1".padStart(64, "0")}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(plain)
            .expect(201);

        // What the registry would have answered.
        await imageLayerRepository.replaceForImage(res.body.imageId, parseImageMetadata(NGINX).layers, "registry");
        const updated = await resolveStoredLayerIndexes(res.body.imageId, res.body.id);
        expect(updated).toBeGreaterThanOrEqual(68);

        const base = await getTestDb()
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.components)
            .where(and(eq(schema.components.sbomId, res.body.id), eq(schema.components.tier, "os"), eq(schema.components.layerIndex, 0)));
        expect(base[0]!.n).toBe(15);
    });
});

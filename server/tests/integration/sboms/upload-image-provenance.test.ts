/**
 * The upload path trusts `imageRef` over the cosmetic registry/repository
 * fields, exactly as the inventory path does (see
 * `inventory/image-ref-precedence.test.ts` for the shared reasoning).
 *
 * The regression this pins: agents ≤0.1.7 parsed a digest-pinned pod's bare
 * image ID as a display name and sent `repository=sha256` with no registry;
 * the old precedence kept that repository and only *backfilled* the registry
 * from the ref, writing hybrid rows like
 * `registry.example.com / sha256`.
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const MINIMAL_SBOM = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [],
};

const DIGEST = `sha256:${"e".repeat(64)}`;
/* The bare image ID containerd reports for a digest-pinned pod. */
const BARE_ID = `sha256:${"f".repeat(64)}`;

describe("POST /v1/sboms/upload/cyclonedx — image provenance comes from the ref", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    function upload(params: Record<string, string>) {
        const query = new URLSearchParams({ imageDigest: DIGEST, ...params });
        return request(app)
            .post(`/v1/sboms/upload/cyclonedx?${query}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM);
    }

    async function image() {
        const [row] = await getTestDb().select().from(schema.images).where(eq(schema.images.digest, DIGEST));
        return row;
    }

    it("prefers the ref over wrong explicit fields — the 0.1.7 digest-pinned shape", async () => {
        await upload({
            imageRef: `registry.example.com/acme/app@${DIGEST}`,
            repository: "sha256",
        }).expect(201);

        expect(await image()).toMatchObject({
            registry: "registry.example.com",
            repository: "acme/app",
        });
    });

    it("uses the explicit fields when no ref is supplied", async () => {
        await upload({ registry: "ghcr.io", repository: "acme/api" }).expect(201);

        expect(await image()).toMatchObject({ registry: "ghcr.io", repository: "acme/api" });
    });

    it("falls back to the explicit fields when the ref is a bare image ID", async () => {
        await upload({
            imageRef: BARE_ID,
            registry: "ghcr.io",
            repository: "acme/api",
        }).expect(201);

        // The empty parse of a digest-only ref must not clobber real values.
        expect(await image()).toMatchObject({ registry: "ghcr.io", repository: "acme/api" });
    });
});

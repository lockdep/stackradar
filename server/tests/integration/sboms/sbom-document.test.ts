import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createSbom,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { validateCycloneDx } from "../../../src/validators/index.js";
import { sbomDocumentFilename } from "../../../src/lib/sbom-filename.js";

/**
 * GET /api/sboms/:id/document — the CycloneDX document a customer can open
 * or save, which is what "saved SBOMs" on the pricing page promises.
 *
 * The contract: the bytes the scanner uploaded come back verbatim and still
 * validate against the vendored CycloneDX schema; `?download=1` turns the
 * response into an attachment named `<image>-<digest8>.cyclonedx.json`; and
 * another org's SBOM is a 404, never a 403, exactly as for `GET /api/sboms/:id`.
 */
describe("SBOM document download", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    const document = {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
            timestamp: "2024-01-01T00:00:00Z",
            component: { type: "application", name: "test-app", version: "1.0.0" },
        },
        components: [{ type: "library", name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21" }],
    };

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    function authHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    async function seedStoredDocument(orgId: string, clusterId: string) {
        const db = getTestDb();
        const image = await createImage(db, orgId, clusterId, {
            registry: "docker.io",
            repository: "library/nginx",
            digest: "sha256:" + "abcdef12".padEnd(64, "0"),
        });
        await seedRunningImage(db, orgId, clusterId, { image });
        const sbom = await createSbom(db, { imageId: image.id });
        await db.update(schema.sboms).set({ rawJson: document }).where(eq(schema.sboms.id, sbom.id));
        return { image, sbom };
    }

    it("serves the uploaded document verbatim, inline, and it still validates", async () => {
        const { sbom } = await seedStoredDocument(testData.org.id, testData.cluster.id);

        const response = await request(app).get(`/api/sboms/${sbom.id}/document`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toMatch(/application\/json/);
        expect(response.headers["content-disposition"]).toBeUndefined();
        expect(response.body).toEqual(document);
        expect(validateCycloneDx(response.body)).toEqual({ valid: true, errors: [] });
    });

    it("sends an attachment named after the image and digest with ?download=1", async () => {
        const { sbom } = await seedStoredDocument(testData.org.id, testData.cluster.id);

        const response = await request(app)
            .get(`/api/sboms/${sbom.id}/document`)
            .query({ download: "1" })
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.headers["content-disposition"]).toBe('attachment; filename="nginx-abcdef12.cyclonedx.json"');
        expect(response.body).toEqual(document);
    });

    it("falls back to the reconstructed document when no raw JSON was stored", async () => {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);
        const sbom = await createSbom(db, { imageId: image.id });

        const response = await request(app).get(`/api/sboms/${sbom.id}/document`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.bomFormat).toBe("CycloneDX");
        expect(validateCycloneDx(response.body).valid).toBe(true);
    });

    it("404s on another org's SBOM — never a 403", async () => {
        const db = getTestDb();
        const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-doc" });
        const { sbom } = await seedStoredDocument(other.org.id, other.cluster.id);

        const response = await request(app)
            .get(`/api/sboms/${sbom.id}/document`)
            .query({ download: "1" })
            .set(authHeaders());

        expect(response.status).toBe(404);
        expect(response.headers["content-disposition"]).toBeUndefined();
    });

    it("404s on an unknown SBOM id", async () => {
        const response = await request(app)
            .get(`/api/sboms/00000000-0000-4000-8000-000000000000/document`)
            .set(authHeaders());
        expect(response.status).toBe(404);
    });

    describe("filename", () => {
        it("uses the last repository segment and eight digest hex characters", () => {
            expect(sbomDocumentFilename("library/nginx", "sha256:" + "abcdef12".padEnd(64, "0"))).toBe(
                "nginx-abcdef12.cyclonedx.json",
            );
        });

        it("never produces a dangling separator when a half is missing", () => {
            expect(sbomDocumentFilename(null, null)).toBe("image-unknown.cyclonedx.json");
            expect(sbomDocumentFilename("weird name!", "not-a-digest")).toBe("weird-name-unknown.cyclonedx.json");
        });
    });
});

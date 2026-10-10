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

/**
 * Who may read and delete an SBOM.
 *
 * `sboms` has no `orgId` because it inherits tenancy from `images` — and since
 * ADR 0006 an image belongs to one cluster and therefore one org, so the check
 * is a column comparison on `images.org_id`. The same digest running in two
 * clusters is two image rows, each with its own SBOM. For a while these two
 * endpoints did not check at all: a UUID was the only thing between one tenant
 * and another's full component list, or another's SBOM and a `DELETE`.
 *
 * These are the tests for the rule in `db/tenancy.ts`: **an org may see an
 * image it owns**, and nothing else grants access.
 */
describe("SBOM tenancy", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

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

    describe("GET /api/sboms/:id", () => {
        it("serves an SBOM on an image the org runs", async () => {
            const db = getTestDb();
            const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const response = await request(app)
                .get(`/api/sboms/${sbom.id}`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.id).toBe(sbom.id);
        });

        it("404s on an SBOM belonging to another org", async () => {
            const db = getTestDb();
            const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-sbom" });
            const { image } = await seedRunningImage(db, other.org.id, other.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const response = await request(app)
                .get(`/api/sboms/${sbom.id}`)
                .set(authHeaders());

            expect(response.status).toBe(404);
        });

        /**
         * The upload-before-inventory case: an image no workload references
         * yet is still its owning org's upload — visible to them, and to
         * nobody else. Under the old workload-derived rule it was invisible
         * to everyone; `images.orgId` is what makes owner visibility correct.
         */
        it("serves an SBOM of an undeployed image to its owning org only", async () => {
            const db = getTestDb();
            const image = await createImage(db, testData.org.id, testData.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const owner = await request(app)
                .get(`/api/sboms/${sbom.id}`)
                .set(authHeaders());
            expect(owner.status).toBe(200);
            expect(owner.body.id).toBe(sbom.id);

            const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-undeployed" });
            const theirs = await request(app)
                .get(`/api/sboms/${sbom.id}`)
                .set(createInternalHeaders({
                    id: other.user.id,
                    email: other.user.email,
                    orgId: other.org.id,
                    orgName: other.org.name,
                    orgSlug: other.org.slug,
                }));
            expect(theirs.status).toBe(404);
        });

        /**
         * The same digest legitimately runs in two tenants — since ADR 0006
         * that is two image rows, one per cluster, each with its own SBOM.
         * Each org reads its own row's SBOM; the identical digest string
         * grants no access to the other tenant's row.
         */
        it("keeps two orgs' SBOMs of the same digest separate", async () => {
            const db = getTestDb();
            const digest = `sha256:${"ab".repeat(32)}`;

            const mineImage = await createImage(db, testData.org.id, testData.cluster.id, { digest });
            const mineSbom = await createSbom(db, { imageId: mineImage.id });
            await seedRunningImage(db, testData.org.id, testData.cluster.id, { image: mineImage });

            const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-shared" });
            const theirImage = await createImage(db, other.org.id, other.cluster.id, { digest });
            const theirSbom = await createSbom(db, { imageId: theirImage.id });
            await seedRunningImage(db, other.org.id, other.cluster.id, { image: theirImage });

            const otherHeaders = createInternalHeaders({
                id: other.user.id,
                email: other.user.email,
                orgId: other.org.id,
                orgName: other.org.name,
                orgSlug: other.org.slug,
            });

            const mine = await request(app).get(`/api/sboms/${mineSbom.id}`).set(authHeaders());
            const theirs = await request(app).get(`/api/sboms/${theirSbom.id}`).set(otherHeaders);
            expect(mine.status).toBe(200);
            expect(theirs.status).toBe(200);

            const crossMine = await request(app).get(`/api/sboms/${theirSbom.id}`).set(authHeaders());
            const crossTheirs = await request(app).get(`/api/sboms/${mineSbom.id}`).set(otherHeaders);
            expect(crossMine.status).toBe(404);
            expect(crossTheirs.status).toBe(404);
        });

        it("refuses a caller with no organisation context", async () => {
            const db = getTestDb();
            const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const response = await request(app)
                .get(`/api/sboms/${sbom.id}`)
                .set(createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                }));

            expect(response.status).toBe(403);
        });
    });

    describe("DELETE /api/sboms/:id", () => {
        it("deletes an SBOM on an image the org runs", async () => {
            const db = getTestDb();
            const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const response = await request(app)
                .delete(`/api/sboms/${sbom.id}`)
                .set(authHeaders());

            expect(response.status).toBe(204);

            const remaining = await db
                .select()
                .from(schema.sboms)
                .where(eq(schema.sboms.id, sbom.id));
            expect(remaining).toHaveLength(0);
        });

        /**
         * The worst of the three: knowing a UUID was enough to destroy another
         * tenant's scan result.
         */
        it("404s on another org's SBOM and leaves it in place", async () => {
            const db = getTestDb();
            const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-del" });
            const { image } = await seedRunningImage(db, other.org.id, other.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const response = await request(app)
                .delete(`/api/sboms/${sbom.id}`)
                .set(authHeaders());

            expect(response.status).toBe(404);

            const remaining = await db
                .select()
                .from(schema.sboms)
                .where(eq(schema.sboms.id, sbom.id));
            expect(remaining).toHaveLength(1);
        });

        it("deletes an SBOM on an undeployed image the org owns", async () => {
            const db = getTestDb();
            const image = await createImage(db, testData.org.id, testData.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const response = await request(app)
                .delete(`/api/sboms/${sbom.id}`)
                .set(authHeaders());

            expect(response.status).toBe(204);

            const remaining = await db
                .select()
                .from(schema.sboms)
                .where(eq(schema.sboms.id, sbom.id));
            expect(remaining).toHaveLength(0);
        });

        it("404s on another org's undeployed image's SBOM and leaves it in place", async () => {
            const db = getTestDb();
            const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-undel" });
            const image = await createImage(db, other.org.id, other.cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            const response = await request(app)
                .delete(`/api/sboms/${sbom.id}`)
                .set(authHeaders());

            expect(response.status).toBe(404);

            const remaining = await db
                .select()
                .from(schema.sboms)
                .where(eq(schema.sboms.id, sbom.id));
            expect(remaining).toHaveLength(1);
        });
    });
});

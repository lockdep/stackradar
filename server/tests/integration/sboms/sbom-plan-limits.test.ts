import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    seedRunningImage,
    createSbom,
    seedTestScenario,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import { PLAN_REQUIRED_CODE } from "../../../src/lib/plan-gate.js";
import { edition } from "../../../src/edition.js";

const MINIMAL_SBOM = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [],
};

describe("SBOM plan limits", () => {
    let app: Express;

    beforeAll(async () => {
        app = await getTestApp();
    });

    // -------------------------------------------------------------------------
    // Uploads are uncapped on every tier. The counter and its enforcement
    // machinery are gone entirely (see the note in `src/config/plans.ts`) —
    // completeness of the current picture is never charged for, so all these
    // tests assert is that plan choice cannot make an upload fail.
    // -------------------------------------------------------------------------

    describe("uploads are uncapped", () => {
        let testData: SeedTestScenarioResult;

        beforeEach(async () => {
            await cleanAllData();
            testData = await seedTestScenario(getTestDb(), {}, { plan: "free" });
        });

        // The gate is the cloud's; the community edition has no plans and uploads everything.
        it.runIf(edition.billing)("refuses upload on an org without a plan (read-only, not a cap)", async () => {
            const digest = `sha256:${randomUUID().replace(/-/g, "").padEnd(64, "0")}`;

            const res = await request(app)
                .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(MINIMAL_SBOM);

            expect(res.status).toBe(403);
            expect(res.body.code).toBe(PLAN_REQUIRED_CODE);
        });

        it("should allow upload on the paid tiers", async () => {
            const db = getTestDb();

            for (const plan of ["pro", "team"] as const) {
                await cleanAllData();
                const paid = await seedTestScenario(db, {}, { plan });
                const digest = `sha256:${randomUUID().replace(/-/g, "").padEnd(64, "0")}`;

                const res = await request(app)
                    .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
                    .set(createApiKeyHeaders(paid.apiKey.rawKey))
                    .send(MINIMAL_SBOM);

                expect(res.status, `plan ${plan}`).toBe(201);
            }
        });
    });

    // -------------------------------------------------------------------------
    // SBOM reads are never windowed by plan. One SBOM per image means the SBOM
    // set is the *current inventory*, not a timeline; an age cutoff here hid a
    // still-running image's SBOM from exactly the "are we affected?" question
    // the product answers. `historyDays` applies to history surfaces (trend
    // snapshots, scan runs, the orphaned-image archive) — never to these
    // endpoints. See the history-window note in `src/config/plans.ts`.
    // -------------------------------------------------------------------------

    describe("SBOM reads ignore historyDays", () => {
        it("lists an SBOM however old, while its image is running (free plan)", async () => {
            await cleanAllData();
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db, {}, { plan: "free" });
            const cluster = await createCluster(db, org.id, { name: "prod" });

            const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
            const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // past every plan window

            /* Two images, because an image has exactly one SBOM. Both have to
               be *running* — an SBOM is scoped to the org through the
               containers that reference its image, not through a column on the
               SBOM itself. */
            const recent = await seedRunningImage(db, org.id, cluster.id, { workloadName: "recent" });
            const old = await seedRunningImage(db, org.id, cluster.id, { workloadName: "old" });
            await createSbom(db, { imageId: recent.image.id, createdAt: recentDate });
            await createSbom(db, { imageId: old.image.id, createdAt: oldDate });

            const headers = createInternalHeaders({
                id: user.id,
                email: user.email,
                orgId: org.id,
                orgName: org.name,
                orgSlug: org.slug,
            });

            const res = await request(app).get("/api/sboms").set(headers);
            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(2);
        });

        it("returns an SBOM by id however old, while its image is running (free plan)", async () => {
            await cleanAllData();
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db, {}, { plan: "free" });
            const cluster = await createCluster(db, org.id, { name: "prod" });
            const { image } = await seedRunningImage(db, org.id, cluster.id);

            const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
            const sbom = await createSbom(db, { imageId: image.id, createdAt: oldDate });

            const headers = createInternalHeaders({
                id: user.id,
                email: user.email,
                orgId: org.id,
                orgName: org.name,
                orgSlug: org.slug,
            });

            const res = await request(app).get(`/api/sboms/${sbom.id}`).set(headers);
            expect(res.status).toBe(200);
        });
    });
});

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";

describe("Internal authentication", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await createOrgWithOwner(db);
    });

    it("should authenticate with valid internal key and headers", async () => {
        const response = await request(app)
            .get(`/api/organizations/${testData.org.id}`)
            .set(
                createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                    orgName: testData.org.name,
                    orgSlug: testData.org.slug,
                })
            );

        expect(response.status).toBe(200);
    });

    it("should reject invalid internal key", async () => {
        const response = await request(app)
            .get(`/api/organizations/${testData.org.id}`)
            .set({
                "X-Internal-Key": "wrong-key",
                "X-User-Id": testData.user.id,
                "X-User-Email": testData.user.email,
            });

        expect(response.status).toBe(401);
    });
});

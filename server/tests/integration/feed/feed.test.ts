/**
 * `GET /api/feed` — the activity feed's reader. A flat page of
 * `activity_events`, newest first, keyset-paginated, clamped to the plan's
 * history window, and never another org's.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, createCluster, type CreateOrgWithOwnerResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { ActivityEventType } from "../../../src/db/schema/remediation.js";

const DAY = 24 * 60 * 60 * 1000;

import { edition } from "../../../src/edition.js";
// Plan limits and history windows are the cloud's: the community edition has one plan with no caps
// and one window, so these cases skip under `STACKRADAR_EDITION=community`.
const itCloud = it.skipIf(!edition.isCloud);

describe("GET /api/feed", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;
    let clusterId: string;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        // No plan: the 30-day window the clamp tests read against (reads are not gated).
        testData = await createOrgWithOwner(db, {}, { plan: "free" });
        const cluster = await createCluster(db, testData.org.id, { name: "prod-eu" });
        clusterId = cluster.id;
    });

    function headers() {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
        });
    }

    async function event(
        type: ActivityEventType,
        ageMs: number,
        opts: { orgId?: string; clusterId?: string | null; payload?: Record<string, unknown> } = {},
    ) {
        const [row] = await getTestDb()
            .insert(schema.activityEvents)
            .values({
                orgId: opts.orgId ?? testData.org.id,
                clusterId: opts.clusterId === undefined ? clusterId : opts.clusterId,
                type,
                payload: opts.payload ?? {},
                createdAt: new Date(Date.now() - ageMs),
            })
            .returning();
        return row!;
    }

    it("returns the org's events newest first with the cluster name joined in", async () => {
        const older = await event("container.appeared", 2 * DAY);
        const newer = await event("container.image-changed", 1 * DAY);

        const res = await request(app).get("/api/feed").set(headers());

        expect(res.status).toBe(200);
        expect(res.body.events.map((e: { id: string }) => e.id)).toEqual([newer.id, older.id]);
        expect(res.body.events[0].clusterName).toBe("prod-eu");
        expect(res.body.nextCursor).toBeNull();
    });

    it("serves only the events that answer the feed's questions", async () => {
        await event("issue.created", 1000);
        await event("finding.suppressed", 2000);
        await event("scan.criticals-increased", 3000);
        const kept = await event("scan.findings-changed", 4000);

        const res = await request(app).get("/api/feed").set(headers());

        expect(res.body.events.map((e: { id: string }) => e.id)).toEqual([kept.id]);
    });

    it("paginates on a stable keyset cursor", async () => {
        for (let i = 0; i < 5; i++) await event("container.appeared", i * 1000);

        const first = await request(app).get("/api/feed?limit=2").set(headers());
        expect(first.body.events).toHaveLength(2);
        expect(first.body.nextCursor).toEqual(expect.any(String));

        const second = await request(app)
            .get(`/api/feed?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
            .set(headers());
        expect(second.body.events).toHaveLength(2);

        const third = await request(app)
            .get(`/api/feed?limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`)
            .set(headers());
        expect(third.body.events).toHaveLength(1);
        expect(third.body.nextCursor).toBeNull();

        const ids = [...first.body.events, ...second.body.events, ...third.body.events].map((e) => e.id);
        expect(new Set(ids).size).toBe(5);
    });

    it("rejects a malformed cursor", async () => {
        const res = await request(app).get("/api/feed?cursor=not-a-cursor").set(headers());
        expect(res.status).toBe(400);
    });

    itCloud("clamps days to the plan's history window", async () => {
        await event("container.appeared", 10 * DAY);
        await event("container.appeared", 40 * DAY);

        // The plan is the org row's, not the header's.
        const free = await request(app).get("/api/feed?days=365").set(headers());
        expect(free.body.days).toBe(30);
        expect(free.body.historyDays).toBe(30);
        expect(free.body.events).toHaveLength(1);

        const db = getTestDb();
        const proOrg = await createOrgWithOwner(db, { email: "pro@test.com" }, { slug: "pro-org", plan: "pro" });
        await event("container.appeared", 10 * DAY, { orgId: proOrg.org.id, clusterId: null });
        await event("container.appeared", 40 * DAY, { orgId: proOrg.org.id, clusterId: null });
        const pro = await request(app)
            .get("/api/feed?days=365")
            .set(createInternalHeaders({ id: proOrg.user.id, email: proOrg.user.email, orgId: proOrg.org.id }));
        expect(pro.body.days).toBe(365);
        expect(pro.body.events).toHaveLength(2);
    });

    it("scopes to one cluster on request", async () => {
        const db = getTestDb();
        const other = await createCluster(db, testData.org.id, { name: "staging" });
        await event("container.appeared", 1000, { clusterId: other.id });
        await event("container.appeared", 2000);

        const res = await request(app).get(`/api/feed?cluster=${clusterId}`).set(headers());
        expect(res.body.events).toHaveLength(1);
        expect(res.body.events[0].clusterName).toBe("prod-eu");
    });

    it("never returns another org's events", async () => {
        const db = getTestDb();
        const stranger = await createOrgWithOwner(db);
        await event("container.appeared", 1000, { orgId: stranger.org.id, clusterId: null });
        await event("container.appeared", 2000);

        const res = await request(app).get("/api/feed").set(headers());
        expect(res.body.events).toHaveLength(1);
        expect(res.body.events[0].orgId).toBe(testData.org.id);
    });

    it("refuses an API key", async () => {
        const res = await request(app).get("/api/feed").set({ "X-API-Key": "sr_whatever" });
        expect([401, 403]).toContain(res.status);
    });
});

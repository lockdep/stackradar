/**
 * `GET /api/admin/system` — the System tab's report.
 *
 * What the operator reads there has to be the process's effective
 * configuration, so the assertions compare against the modules the running
 * code reads (`edition`, `topology`, `SERVER_VERSION`) rather than against
 * literals. The two properties worth a test of their own: the migration
 * state agrees with the journal the test database was built from, and
 * nothing secret travels — the response is admin-only, but admin-only is
 * not a reason to put the service key on a web page.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { createInternalHeaders, getTestApp } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, type CreateOrgWithOwnerResult } from "../../fixtures/seed-data.js";
import { edition } from "../../../src/edition.js";
import { topology } from "../../../src/topology.js";
import { SERVER_VERSION } from "../../../src/lib/server-version.js";

describe("GET /api/admin/system", () => {
    let app: Express;
    let t: CreateOrgWithOwnerResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        t = await createOrgWithOwner(getTestDb(), { email: "admin@system.test" });
    });

    const headers = (isAdmin: boolean) =>
        createInternalHeaders({
            id: t.user.id,
            email: t.user.email,
            orgId: t.org.id,
            orgName: t.org.name,
            orgSlug: t.org.slug,
            orgPlan: t.org.plan,
            isAdmin,
        });

    it("is platform-admin only", async () => {
        const res = await request(app).get("/api/admin/system").set(headers(false));
        expect(res.status).toBe(403);
    });

    it("reports the build, the edition and the topology the process actually runs with", async () => {
        const res = await request(app).get("/api/admin/system").set(headers(true));
        expect(res.status).toBe(200);
        expect(res.body.build.version).toBe(SERVER_VERSION);
        expect(res.body.build.node).toBe(process.version);
        expect(res.body.build.uptimeSeconds).toBeGreaterThanOrEqual(0);
        expect(res.body.edition.value).toBe(edition.edition);
        expect(res.body.topology.value).toBe(topology);
        expect(["set", "default"]).toContain(res.body.edition.source);
    });

    it("says the server's schema is current — the test database was built from this chain", async () => {
        const journal = JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf-8")) as {
            entries: Array<{ tag: string }>;
        };
        const newest = journal.entries[journal.entries.length - 1]!.tag;

        const res = await request(app).get("/api/admin/system").set(headers(true));
        const { server, auth } = res.body.migrations;

        expect(server.applied).toBe(journal.entries.length);
        expect(server.chainLength).toBe(journal.entries.length);
        expect(server.chainLatestTag).toBe(newest);
        expect(server.latestTag).toBe(newest);
        expect(server.current).toBe(true);
        // The client's chain has never run against this database: a fact, not an error.
        expect(auth).toEqual({ applied: null, latestAppliedAt: null });
    });

    it("lists every operator knob with its effective value, and no secret", async () => {
        const res = await request(app).get("/api/admin/system").set(headers(true));
        const keys = (res.body.config as Array<{ key: string; value: string; source: string }>).map((r) => r.key);
        for (const key of [
            "OSV_ECOSYSTEMS",
            "IMAGE_GC_RETENTION_DAYS",
            "SCANNER_MIN_VERSION",
            "ARTIFACT_HUB_SYNC_ENABLED",
            "APP_URL",
            "PUBLIC_API_URL",
            "LOG_LEVEL",
            "MIGRATE_ON_START",
            "API_KEY_ENCRYPTION_KEY",
        ]) {
            expect(keys, key).toContain(key);
        }

        const body = JSON.stringify(res.body);
        for (const secret of [
            process.env.INTERNAL_SERVICE_KEY,
            process.env.DATABASE_URL,
            process.env.API_KEY_ENCRYPTION_KEY,
            process.env.BOOTSTRAP_CLUSTER_API_KEY,
        ]) {
            if (secret) expect(body).not.toContain(secret);
        }
        const vault = (res.body.config as Array<{ key: string; value: string }>).find(
            (r) => r.key === "API_KEY_ENCRYPTION_KEY",
        );
        expect(["configured", "not set"]).toContain(vault?.value);
    });
});

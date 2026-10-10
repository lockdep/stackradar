/**
 * Chart repository settings — docs/proposals/fix-tab-suggestions.md phase 2.
 *
 * The rules under test:
 * - credentials go in and never come back out (`hasCredentials`, not the
 *   secret);
 * - only http(s) URLs are accepted — an `oci://` row would be a row nothing
 *   can refresh;
 * - `observed` is not a source a request may claim; auto-registration is the
 *   sync's job and never resurrects a deleted row;
 * - charts whose releases carry no `repoUrl` are listed as the discovery
 *   worklist.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import {
    seedTestScenario,
    createHelmRelease,
    createUser,
    addOrgMember,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/** Lazily imported so `src/db` initialises after DATABASE_URL points at the container. */
async function repository() {
    const { chartRepositoryRepository } = await import(
        "../../../src/repositories/chart-repository.repository.js"
    );
    return chartRepositoryRepository;
}

let app: Awaited<ReturnType<typeof getTestApp>>;
let scenario: SeedTestScenarioResult;

function authHeaders() {
    return createInternalHeaders({
        id: scenario.user.id,
        email: scenario.user.email,
        orgId: scenario.org.id,
    });
}

beforeAll(async () => {
    app = await getTestApp();
});

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

describe("chart repositories", () => {
    it("registers a repository with credentials and never returns the secret", async () => {
        const created = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({
                url: "https://charts.example.com",
                username: "svc-account",
                password: "hunter2",
            });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            url: "https://charts.example.com",
            source: "manual",
            enabled: true,
            hasCredentials: true,
        });
        expect(created.body.password).toBeUndefined();
        expect(created.body.username).toBeUndefined();

        const list = await request(app).get("/api/chart-repositories").set(authHeaders());
        expect(list.status).toBe(200);
        expect(list.body.repositories).toHaveLength(1);
        expect(list.body.repositories[0].hasCredentials).toBe(true);
        expect(JSON.stringify(list.body)).not.toContain("hunter2");
    });

    it("rejects non-http(s) URLs and duplicate registrations", async () => {
        const oci = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "oci://ghcr.io/acme/charts" });
        expect(oci.status).toBe(400);

        const first = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "https://charts.bitnami.com/bitnami" });
        expect(first.status).toBe(201);

        const duplicate = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "https://charts.bitnami.com/bitnami" });
        expect(duplicate.status).toBe(409);
    });

    it("rejects a request claiming the observed source", async () => {
        const res = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "https://charts.example.com", source: "observed" });
        expect(res.status).toBe(400);
    });

    it("rejects a request claiming the artifact-hub-matched source", async () => {
        // Same reasoning as `observed`: the source claims machine-gathered
        // evidence a request cannot have. Only the nightly attribution pass
        // writes it.
        const res = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "https://charts.example.com", source: "artifact-hub-matched" });
        expect(res.status).toBe(400);
    });

    it("disables, re-enables and deletes a repository", async () => {
        const created = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "https://charts.example.com" });
        const id = created.body.id;

        const disabled = await request(app)
            .patch(`/api/chart-repositories/${id}`)
            .set(authHeaders())
            .send({ enabled: false });
        expect(disabled.status).toBe(200);
        expect(disabled.body.enabled).toBe(false);

        const deleted = await request(app)
            .delete(`/api/chart-repositories/${id}`)
            .set(authHeaders())
            .send();
        expect(deleted.status).toBe(200);

        const list = await request(app).get("/api/chart-repositories").set(authHeaders());
        expect(list.body.repositories).toHaveLength(0);
    });

    it("lists charts whose releases have no known repository", async () => {
        const db = getTestDb();
        await createHelmRelease(db, scenario.org.id, scenario.cluster.id, {
            name: "grafana", namespace: "monitoring", chartName: "grafana",
            chartVersion: "7.0.0", repoUrl: null,
        });
        await createHelmRelease(db, scenario.org.id, scenario.cluster.id, {
            name: "kps", namespace: "monitoring", chartName: "kube-prometheus-stack",
            chartVersion: "82.18.0",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
        });

        const list = await request(app).get("/api/chart-repositories").set(authHeaders());
        expect(list.status).toBe(200);
        // Known-repo charts are not a discovery problem; unknown ones are.
        expect(list.body.unknownCharts).toEqual(["grafana"]);
    });

    it("refresh enqueues a job and the job records the fetch failure on the row", async () => {
        const created = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            // Nothing listens here; the fetch fails fast and the failure is
            // recorded on the row for the settings page to show.
            .send({ url: "http://127.0.0.1:1" });
        const id = created.body.id;

        // The request path only enqueues (security-review-2026-08-22.md § S1):
        // the user-supplied index is fetched and parsed by the worker.
        const accepted = await request(app)
            .post(`/api/chart-repositories/${id}/refresh`)
            .set(authHeaders())
            .send();
        expect(accepted.status).toBe(202);
        expect(accepted.body.job.type).toBe("chart_repo_refresh");
        expect(accepted.body.job.status).toBe("pending");
        expect(accepted.body.repository.lastFetchedAt).toBeNull();

        // A second click while the job is open returns the same job.
        const again = await request(app)
            .post(`/api/chart-repositories/${id}/refresh`)
            .set(authHeaders())
            .send();
        expect(again.status).toBe(202);
        expect(again.body.job.id).toBe(accepted.body.job.id);

        const { runChartRepoRefreshJob } = await import("../../../src/services/chart-repo.service.js");
        const result = await runChartRepoRefreshJob(scenario.org.id, { repositoryId: id });
        expect(result.status).toBe("error");

        const list = await request(app).get("/api/chart-repositories").set(authHeaders());
        const row = list.body.repositories.find((r: { id: string }) => r.id === id);
        expect(row.lastFetchError).toBeTruthy();
        expect(row.lastFetchedAt).toBeTruthy();
    });

    it("the refresh job refuses a repository from another org", async () => {
        const created = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "http://127.0.0.1:1" });
        const { runChartRepoRefreshJob } = await import("../../../src/services/chart-repo.service.js");
        await expect(
            runChartRepoRefreshJob("00000000-0000-0000-0000-000000000000", { repositoryId: created.body.id })
        ).rejects.toThrow("not found");
    });

    it("auto-registration never resurrects a deleted repository", async () => {
        const db = getTestDb();
        const repo = await repository();
        const orgId = scenario.org.id;
        await createHelmRelease(db, orgId, scenario.cluster.id, {
            name: "redis", namespace: "default", chartName: "redis", chartVersion: "18.0.0",
            repoUrl: "https://charts.bitnami.com/bitnami",
        });

        // First observation registers the repo.
        const registered = await repo.registerObserved(orgId, [
            "https://charts.bitnami.com/bitnami",
        ]);
        expect(registered).toBe(1);

        // The user disables it; a later observation must not flip it back.
        const [row] = await repo.listForOrg(orgId);
        await repo.update(row!.id, orgId, { enabled: false });
        const again = await repo.registerObserved(orgId, [
            "https://charts.bitnami.com/bitnami",
        ]);
        expect(again).toBe(0);
        const [after] = await repo.listForOrg(orgId);
        expect(after!.enabled).toBe(false);
    });
});

describe("chart repository role gating", () => {
    // This surface lives in Organization Settings, so mutations are
    // admin/owner-only (`requireAdminOrOwner`); reads stay member-accessible.

    async function memberHeaders() {
        const db = getTestDb();
        const member = await createUser(db);
        await addOrgMember(db, member.id, scenario.org.id, "member");
        return createInternalHeaders({
            id: member.id,
            email: member.email,
            orgId: scenario.org.id,
        });
    }

    it("should return 403 when a member creates, updates, deletes or refreshes", async () => {
        const created = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "https://charts.example.com" });
        expect(created.status).toBe(201);
        const id = created.body.id;

        const asMember = await memberHeaders();

        const create = await request(app)
            .post("/api/chart-repositories")
            .set(asMember)
            .send({ url: "https://charts.other.example.com" });
        expect(create.status).toBe(403);
        expect(create.body.error).toBe("Admin or owner role required");

        const update = await request(app)
            .patch(`/api/chart-repositories/${id}`)
            .set(asMember)
            .send({ enabled: false });
        expect(update.status).toBe(403);

        const refresh = await request(app)
            .post(`/api/chart-repositories/${id}/refresh`)
            .set(asMember)
            .send();
        expect(refresh.status).toBe(403);

        const del = await request(app)
            .delete(`/api/chart-repositories/${id}`)
            .set(asMember)
            .send();
        expect(del.status).toBe(403);
    });

    it("should let a member list repositories", async () => {
        const created = await request(app)
            .post("/api/chart-repositories")
            .set(authHeaders())
            .send({ url: "https://charts.example.com" });
        expect(created.status).toBe(201);

        const list = await request(app)
            .get("/api/chart-repositories")
            .set(await memberHeaders());
        expect(list.status).toBe(200);
        expect(list.body.repositories).toHaveLength(1);
    });

    it("should let an admin mutate repositories", async () => {
        const db = getTestDb();
        const admin = await createUser(db);
        await addOrgMember(db, admin.id, scenario.org.id, "admin");
        const asAdmin = createInternalHeaders({
            id: admin.id,
            email: admin.email,
            orgId: scenario.org.id,
        });

        const created = await request(app)
            .post("/api/chart-repositories")
            .set(asAdmin)
            .send({ url: "https://charts.example.com" });
        expect(created.status).toBe(201);

        const deleted = await request(app)
            .delete(`/api/chart-repositories/${created.body.id}`)
            .set(asAdmin)
            .send();
        expect(deleted.status).toBe(200);
    });
});

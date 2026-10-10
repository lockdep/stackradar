import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createClusterApiKey,
    createApiKey,
    createImage,
    createSbom,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function container(overrides: Record<string, unknown> = {}) {
    return {
        name: "main",
        init: false,
        imageRef: `ghcr.io/acme/api@${DIGEST_A}`,
        imageDigest: DIGEST_A,
        imageTag: "1.4.2",
        registry: "ghcr.io",
        repository: "acme/api",
        runningPods: 3,
        ...overrides,
    };
}

function workload(overrides: Record<string, unknown> = {}) {
    return {
        kind: "Deployment",
        name: "api",
        release: null,
        application: null,
        runningPods: 3,
        firstStartedAt: "2026-07-02T10:00:00.000Z",
        containers: [container()],
        ...overrides,
    };
}

function report(overrides: Record<string, unknown> = {}) {
    return {
        version: 3,
        reportedAt: "2026-08-15T09:14:22.113Z",
        informerSynced: true,
        ownerMetadataCollected: true,
        releases: [],
        applications: [],
        namespaces: [{ name: "default", labels: {}, workloads: [workload()] }],
        ...overrides,
    };
}

describe("POST /v1/inventory", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;
    let clusterId: string;
    let clusterKey: string;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await createOrgWithOwner(db);
        const cluster = await createCluster(db, testData.org.id);
        clusterId = cluster.id;
        ({ rawKey: clusterKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id));
    });

    function post(body: object) {
        return request(app).post("/v1/inventory").set(createApiKeyHeaders(clusterKey)).send(body);
    }

    function containers() {
        return getTestDb()
            .select()
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.orgId, testData.org.id));
    }

    describe("writing the model", () => {
        it("creates namespaces, workloads, containers and images", async () => {
            const db = getTestDb();
            const res = await post(report());

            expect(res.status).toBe(200);
            expect(res.body.accepted).toEqual({
                namespaces: 1,
                workloads: 1,
                containers: 1,
                releases: 0,
                applications: 0,
            });

            expect(await db.select().from(schema.namespaces)).toHaveLength(1);
            expect(await db.select().from(schema.workloads)).toHaveLength(1);
            expect(await containers()).toHaveLength(1);
            expect(await db.select().from(schema.images)).toHaveLength(1);
        });

        it("stores deployment facts on the container and content facts on the image", async () => {
            const db = getTestDb();
            await post(report());

            const [image] = await db.select().from(schema.images);
            expect(image).toMatchObject({ digest: DIGEST_A, registry: "ghcr.io", repository: "acme/api" });

            const [row] = await containers();
            expect(row).toMatchObject({ name: "main", imageTag: "1.4.2", runningPods: 3, init: false });
        });

        /**
         * The mid-rollout case. Two digests under one container name is the
         * honest report, and the model has to hold both — a fix is only
         * deployed when no container row still references the old image.
         */
        it("stores two rows for one container name during a rollout", async () => {
            await post(report({
                namespaces: [{
                    name: "default",
                    labels: {},
                    workloads: [workload({
                        containers: [
                            container({ imageDigest: DIGEST_A, runningPods: 1 }),
                            container({ imageDigest: DIGEST_B, runningPods: 2, imageRef: `ghcr.io/acme/api@${DIGEST_B}` }),
                        ],
                    })],
                }],
            }));

            const rows = await containers();
            expect(rows).toHaveLength(2);
            expect(rows.every((r) => r.name === "main")).toBe(true);
            expect(rows.map((r) => r.runningPods).sort()).toEqual([1, 2]);
        });

        it("keeps kind null rather than falling back to Pod", async () => {
            const db = getTestDb();
            await post(report({
                namespaces: [{ name: "default", labels: {}, workloads: [workload({ kind: null })] }],
            }));

            const [w] = await db.select().from(schema.workloads);
            expect(w!.kind).toBeNull();
        });

        it("preserves null vs {} for namespace labels", async () => {
            const db = getTestDb();
            await post(report({
                namespaces: [
                    { name: "uncollected", labels: null, workloads: [workload()] },
                    { name: "unlabelled", labels: {}, workloads: [workload({ name: "web" })] },
                ],
            }));

            const rows = await db.select().from(schema.namespaces);
            const byName = new Map(rows.map((r) => [r.name, r]));
            expect(byName.get("uncollected")!.labels).toBeNull();
            expect(byName.get("unlabelled")!.labels).toEqual({});
        });

        it("dedupes one digest reported from five namespaces into one image", async () => {
            const db = getTestDb();
            await post(report({
                namespaces: ["a", "b", "c", "d", "e"].map((name) => ({
                    name,
                    labels: {},
                    workloads: [workload()],
                })),
            }));

            expect(await db.select().from(schema.images)).toHaveLength(1);
            expect(await containers()).toHaveLength(5);
        });

        /**
         * Dedup stops at the cluster boundary (ADR 0006): the conflict target
         * is `(cluster_id, digest)`, so a second cluster reporting the same
         * digest creates its own image row rather than adopting the first's.
         */
        it("stores one image per cluster for a digest reported by two clusters", async () => {
            const db = getTestDb();
            await post(report());

            const secondCluster = await createCluster(db, testData.org.id, { name: "staging" });
            const { rawKey: secondKey } = await createClusterApiKey(
                db,
                secondCluster.id,
                testData.org.id,
                testData.user.id,
            );
            await request(app)
                .post("/v1/inventory")
                .set(createApiKeyHeaders(secondKey))
                .send(report())
                .expect(200);

            const images = await db
                .select()
                .from(schema.images)
                .where(eq(schema.images.digest, DIGEST_A));
            expect(images).toHaveLength(2);
            expect(new Set(images.map((i) => i.clusterId))).toEqual(
                new Set([clusterId, secondCluster.id]),
            );

            // Re-reporting from either cluster upserts onto its own row.
            await post(report());
            expect(
                await db.select().from(schema.images).where(eq(schema.images.digest, DIGEST_A)),
            ).toHaveLength(2);
        });

        it("is idempotent, bumping lastSeenAt without duplicating rows", async () => {
            await post(report());
            const first = await containers();

            await post(report());
            const second = await containers();

            expect(second).toHaveLength(1);
            expect(second[0]!.id).toBe(first[0]!.id);
            expect(second[0]!.firstSeenAt.getTime()).toBe(first[0]!.firstSeenAt.getTime());
            expect(second[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first[0]!.lastSeenAt.getTime());
        });
    });

    describe("full set replacement", () => {
        it("deletes anything the new report omits", async () => {
            await post(report({
                namespaces: [{
                    name: "default",
                    labels: {},
                    workloads: [workload(), workload({ name: "web" })],
                }],
            }));
            expect(await containers()).toHaveLength(2);

            await post(report());
            const rows = await containers();
            expect(rows).toHaveLength(1);
        });

        it("deletes a namespace that has gone away", async () => {
            const db = getTestDb();
            await post(report({
                namespaces: [
                    { name: "default", labels: {}, workloads: [workload()] },
                    { name: "doomed", labels: {}, workloads: [workload()] },
                ],
            }));
            expect(await db.select().from(schema.namespaces)).toHaveLength(2);

            await post(report());
            const rows = await db.select().from(schema.namespaces);
            expect(rows.map((r) => r.name)).toEqual(["default"]);
        });

        /**
         * Images survive a report that stops mentioning them. A digest whose
         * last workload vanished mid-rollout is back seconds later, and
         * dropping its SBOM would mean re-pulling and re-scanning it.
         */
        it("never deletes images, only the containers referencing them", async () => {
            const db = getTestDb();
            await post(report());
            await post(report({
                namespaces: [{
                    name: "default",
                    labels: {},
                    workloads: [workload({
                        containers: [container({ imageDigest: DIGEST_B, imageRef: `ghcr.io/acme/api@${DIGEST_B}` })],
                    })],
                }],
            }));

            const images = await db.select().from(schema.images);
            expect(images.map((i) => i.digest).sort()).toEqual([DIGEST_A, DIGEST_B].sort());
            expect(await containers()).toHaveLength(1);
        });

        /**
         * `last_seen_at` is what stops the GC from mistaking a rollout for
         * garbage, so every report has to stamp the digests it mentions — a
         * backfill-only upsert would leave a permanently deployed image ageing
         * from the day it was first seen.
         */
        it("stamps last_seen_at on every image the report mentions", async () => {
            const db = getTestDb();

            // Backdate past any plausible retention window, then re-report it.
            await post(report());
            const stale = new Date(Date.now() - 400 * 24 * 60 * 60 * 1_000);
            await db.update(schema.images).set({ lastSeenAt: stale });

            await post(report());

            const [image] = await db
                .select()
                .from(schema.images)
                .where(eq(schema.images.digest, DIGEST_A));
            expect(image!.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime());
        });
    });

    describe("helm releases", () => {
        const release = {
            name: "prod-redis",
            namespace: "prod",
            chartName: "redis",
            chartVersion: "18.2.1",
            appVersion: "7.2.4",
            repoUrl: null,
        };

        it("links workloads to the release they belong to", async () => {
            const db = getTestDb();
            await post(report({
                releases: [release],
                namespaces: [{
                    name: "prod",
                    labels: {},
                    workloads: [workload({ release: { name: "prod-redis", namespace: "prod" } })],
                }],
            }));

            const [stored] = await db.select().from(schema.helmReleases);
            expect(stored).toMatchObject({ name: "prod-redis", namespace: "prod", chartName: "redis" });

            const [w] = await db.select().from(schema.workloads);
            expect(w!.releaseId).toBe(stored!.id);
        });

        /**
         * A chart may deploy across namespaces. The release keeps its *own*
         * namespace; grouping by the workload's would split it in two.
         */
        it("keys the release on its own namespace, not the workload's", async () => {
            const db = getTestDb();
            await post(report({
                releases: [release],
                namespaces: [{
                    name: "other-namespace",
                    labels: {},
                    workloads: [workload({ release: { name: "prod-redis", namespace: "prod" } })],
                }],
            }));

            const [stored] = await db.select().from(schema.helmReleases);
            expect(stored!.namespace).toBe("prod");

            const [w] = await db.select().from(schema.workloads);
            expect(w!.releaseId).toBe(stored!.id);
        });

        it("rejects a workload referencing a release not present in releases[]", async () => {
            const res = await post(report({
                releases: [],
                namespaces: [{
                    name: "prod",
                    labels: {},
                    workloads: [workload({ release: { name: "ghost", namespace: "prod" } })],
                }],
            }));

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/not present in releases/i);
        });

        /* `source` is gone from the table and from the wire. A scanner that
           still sends it is ignored rather than rejected — unknown fields are
           the forward-compatibility contract — but nothing stores it. */
        it("ignores a source field a v2 scanner still sends, and stores no such column", async () => {
            const db = getTestDb();
            const res = await post(report({
                releases: [{ ...release, source: "argocd" }],
                namespaces: [{ name: "prod", labels: {}, workloads: [workload()] }],
            }));

            expect(res.status).toBe(200);
            const [stored] = await db.select().from(schema.helmReleases);
            expect(stored).not.toHaveProperty("source");
        });
    });

    /*
     * The delivery layer. Its whole reason for existing is that a workload can
     * be packaged by a chart *and* delivered by an app, and both answers are
     * needed — the chart version is what a CVE report cites, the app is where
     * the fix is made.
     */
    describe("gitops applications", () => {
        const application = {
            name: "kube-prometheus-stack",
            namespace: "argocd",
            tool: "argocd",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
            targetRevision: "82.18.0",
            chart: "kube-prometheus-stack",
            path: null,
            destinationNamespace: "monitoring",
        };

        const release = {
            name: "kube-prometheus-stack",
            namespace: "monitoring",
            chartName: "kube-prometheus-stack",
            chartVersion: "82.18.0",
            appVersion: "82.18.0",
            repoUrl: null,
        };

        it("links workloads to the application that delivers them", async () => {
            const db = getTestDb();
            await post(report({
                applications: [application],
                namespaces: [{
                    name: "monitoring",
                    labels: {},
                    workloads: [workload({
                        application: { name: "kube-prometheus-stack", namespace: "argocd" },
                    })],
                }],
            }));

            const [stored] = await db.select().from(schema.gitopsApplications);
            expect(stored).toMatchObject({
                name: "kube-prometheus-stack",
                // The app object's namespace, not where it deploys.
                namespace: "argocd",
                destinationNamespace: "monitoring",
                targetRevision: "82.18.0",
            });

            const [w] = await db.select().from(schema.workloads);
            expect(w!.applicationId).toBe(stored!.id);
        });

        /* The case the two-table model exists for. `kube-prometheus-stack` is
           legitimately both, and neither reference may displace the other. */
        it("stores both layers for a workload that has both", async () => {
            const db = getTestDb();
            await post(report({
                releases: [release],
                applications: [application],
                namespaces: [{
                    name: "monitoring",
                    labels: {},
                    workloads: [workload({
                        release: { name: "kube-prometheus-stack", namespace: "monitoring" },
                        application: { name: "kube-prometheus-stack", namespace: "argocd" },
                    })],
                }],
            }));

            const [w] = await db.select().from(schema.workloads);
            expect(w!.releaseId).not.toBeNull();
            expect(w!.applicationId).not.toBeNull();
            expect(w!.releaseId).not.toBe(w!.applicationId);
        });

        it("rejects a workload referencing an application not present in applications[]", async () => {
            const res = await post(report({
                applications: [],
                namespaces: [{
                    name: "prod",
                    labels: {},
                    workloads: [workload({ application: { name: "ghost", namespace: "argocd" } })],
                }],
            }));

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/not present in applications/i);
        });

        it("rejects an unknown tool rather than storing it", async () => {
            const res = await post(report({
                applications: [{ ...application, tool: "kapp" }],
                namespaces: [{ name: "prod", labels: {}, workloads: [workload()] }],
            }));

            expect(res.status).toBe(400);
        });

        /* An app whose `Application` object stopped being readable must report
           `null` again rather than keep serving the last value it had — the
           same rule `namespaces.labels` follows. */
        it("clears fields an app no longer reports", async () => {
            const db = getTestDb();
            await post(report({ applications: [application] }));
            await post(report({
                applications: [{
                    ...application,
                    repoUrl: null,
                    targetRevision: null,
                    chart: null,
                    destinationNamespace: null,
                }],
            }));

            const [stored] = await db.select().from(schema.gitopsApplications);
            expect(stored).toMatchObject({ repoUrl: null, targetRevision: null, chart: null });
        });

        /* Set-null, not cascade: the workload is still running, we have merely
           lost the app that claimed it. */
        it("leaves workloads standing when their application stops being reported", async () => {
            const db = getTestDb();
            await post(report({
                applications: [application],
                namespaces: [{
                    name: "monitoring",
                    labels: {},
                    workloads: [workload({
                        application: { name: "kube-prometheus-stack", namespace: "argocd" },
                    })],
                }],
            }));

            await post(report({
                namespaces: [{ name: "monitoring", labels: {}, workloads: [workload()] }],
            }));

            expect(await db.select().from(schema.gitopsApplications)).toHaveLength(0);
            const [w] = await db.select().from(schema.workloads);
            expect(w).toBeDefined();
            expect(w!.applicationId).toBeNull();
        });
    });

    describe("the empty-report hazard", () => {
        it("rejects a report with zero namespaces without touching stored rows", async () => {
            await post(report());
            expect(await containers()).toHaveLength(1);

            const res = await post(report({ namespaces: [] }));

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/zero namespaces/i);
            // Untouched — losing one interval's deletions is cheap; wiping a
            // cluster because an informer hiccuped is not.
            expect(await containers()).toHaveLength(1);
        });

        it("rejects informerSynced:false without touching stored rows", async () => {
            await post(report());

            const res = await post(report({ informerSynced: false, namespaces: [] }));

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/informerSynced/i);
            expect(await containers()).toHaveLength(1);
        });
    });

    describe("versioning", () => {
        it("rejects an older payload with a message naming the minimum chart version", async () => {
            const res = await post({
                workloads: [{
                    namespace: "default",
                    workloadName: "api",
                    containerName: "main",
                    imageRef: "ghcr.io/acme/api:1.0",
                }],
            });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/version 3/i);
            expect(res.body.error).toMatch(/chart/i);
            expect(res.body.error).toMatch(/SBOM upload is unaffected/i);
        });

        it("names the running scanner version when the header carries one", async () => {
            const res = await request(app)
                .post("/v1/inventory")
                .set(createApiKeyHeaders(clusterKey))
                .set("X-Scanner-Version", "0.2.7")
                .send({ workloads: [] });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/0\.2\.7/);
        });

        it("ignores unknown fields so a newer scanner needs no server release", async () => {
            const res = await post({
                ...report(),
                somethingNew: { added: "later" },
                namespaces: [{
                    name: "default",
                    labels: {},
                    alsoNew: true,
                    workloads: [{ ...workload(), futureField: 42 }],
                }],
            });

            expect(res.status).toBe(200);
            expect(res.body.accepted.containers).toBe(1);
        });
    });

    describe("warnings", () => {
        it("reports how many workloads had an unresolved kind", async () => {
            const res = await post(report({
                namespaces: [{
                    name: "default",
                    labels: {},
                    workloads: [workload({ kind: null }), workload({ name: "web", kind: null }), workload({ name: "job" })],
                }],
            }));

            expect(res.status).toBe(200);
            expect(res.body.warnings).toContainEqual({ code: "kind_unresolved", count: 2 });
        });

        it("reports namespaces whose labels could not be collected", async () => {
            const res = await post(report({
                namespaces: [{ name: "default", labels: null, workloads: [workload()] }],
            }));

            expect(res.body.warnings).toContainEqual({ code: "namespace_labels_not_collected", count: 1 });
        });

        /*
         * The warning that separates "no chart claims these workloads" from
         * "we were not allowed to look". No count: the number is not how many
         * workloads are affected, it is that we do not know which ones are.
         */
        it("reports and records that controller metadata was not collected", async () => {
            const db = getTestDb();
            const res = await post(report({ ownerMetadataCollected: false }));

            expect(res.body.warnings).toContainEqual({ code: "owner_metadata_not_collected" });

            const [cluster] = await db
                .select()
                .from(schema.clusters)
                .where(eq(schema.clusters.id, clusterId));
            expect(cluster!.ownerMetadataCollected).toBe(false);
        });

        /* Granting the RBAC takes effect within one interval, so the caveat
           clears itself rather than needing a restart to go away. */
        it("clears the flag again once the agent can read controllers", async () => {
            const db = getTestDb();
            await post(report({ ownerMetadataCollected: false }));
            const res = await post(report({ ownerMetadataCollected: true }));

            expect(res.body.warnings).toEqual([]);
            const [cluster] = await db
                .select()
                .from(schema.clusters)
                .where(eq(schema.clusters.id, clusterId));
            expect(cluster!.ownerMetadataCollected).toBe(true);
        });

        it("emits no warnings for a fully resolved report", async () => {
            const res = await post(report());
            expect(res.body.warnings).toEqual([]);
        });
    });

    describe("authorization", () => {
        it("takes the cluster from the API key, never from the body", async () => {
            const db = getTestDb();
            const otherCluster = await createCluster(db, testData.org.id, { name: "other-cluster" });

            const res = await post({ ...report(), clusterId: otherCluster.id });

            expect(res.status).toBe(200);
            const [ns] = await db.select().from(schema.namespaces);
            expect(ns!.clusterId).toBe(clusterId);
        });

        it("rejects an org-scoped key with 403", async () => {
            const db = getTestDb();
            const orgKey = await createApiKey(db, testData.org.id, testData.user.id);

            const res = await request(app)
                .post("/v1/inventory")
                .set(createApiKeyHeaders(orgKey.rawKey))
                .send(report());

            expect(res.status).toBe(403);
        });

        it("rejects unauthenticated requests", async () => {
            const res = await request(app).post("/v1/inventory").send(report());
            expect(res.status).toBe(401);
        });
    });

    describe("scan failures", () => {
        const authFailure = {
            imageDigest: DIGEST_A,
            code: "registry_auth",
            registryHost: "registry.digitalocean.com",
        };

        function getCoverage() {
            return request(app)
                .get(`/api/clusters/${clusterId}/coverage`)
                .set(createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                    orgName: testData.org.name,
                    orgSlug: testData.org.slug,
                }));
        }

        async function imageRow(digest: string) {
            const [row] = await getTestDb()
                .select()
                .from(schema.images)
                .where(eq(schema.images.digest, digest));
            return row!;
        }

        it("persists a reported failure and surfaces it on the coverage rows in the same cycle", async () => {
            const res = await post(report({ scanFailures: [authFailure] }));
            expect(res.status).toBe(200);

            const image = await imageRow(DIGEST_A);
            expect(image.lastScanErrorCode).toBe("registry_auth");
            expect(image.lastScanErrorHost).toBe("registry.digitalocean.com");
            expect(image.lastScanErrorAt).not.toBeNull();

            // Acceptance criterion: the reason reaches the card within one
            // inventory cycle — no 30-minute "stuck" wait.
            const coverage = await getCoverage();
            expect(coverage.status).toBe(200);
            expect(coverage.body.workloads).toHaveLength(1);
            expect(coverage.body.workloads[0].scanErrorCode).toBe("registry_auth");
            expect(coverage.body.workloads[0].scanErrorHost).toBe("registry.digitalocean.com");
        });

        it("summarises auth failures on the cluster list, so the Dashboard can raise them", async () => {
            await post(report({ scanFailures: [authFailure] }));

            const list = await request(app)
                .get("/api/clusters")
                .set(createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                    orgName: testData.org.name,
                    orgSlug: testData.org.slug,
                }));
            expect(list.status).toBe(200);
            const cluster = list.body.clusters.find((c: { id: string }) => c.id === clusterId);
            expect(cluster.registryAuthFailedHosts).toEqual(["registry.digitalocean.com"]);
            expect(cluster.registryAuthFailedWorkloads).toBe(1);
        });

        it("does not count an auth failure once the image has an SBOM", async () => {
            // A stale error column on a scanned image is history, not a
            // failure: the aggregate must match the coverage rows, which
            // only list containers without an SBOM.
            await post(report({ scanFailures: [{ ...authFailure, code: "registry_auth" }] }));
            await getTestDb()
                .insert(schema.sboms)
                .values({
                    imageId: (await imageRow(DIGEST_A)).id,
                    format: "cyclonedx",
                    sbomSha256: "c".repeat(64),
                    specVersion: "1.6",
                });

            const list = await request(app)
                .get("/api/clusters")
                .set(createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                    orgName: testData.org.name,
                    orgSlug: testData.org.slug,
                }));
            const cluster = list.body.clusters.find((c: { id: string }) => c.id === clusterId);
            expect(cluster.registryAuthFailedHosts).toEqual([]);
            expect(cluster.registryAuthFailedWorkloads).toBe(0);
        });

        it("does not clear a stored failure when a later report omits it", async () => {
            // A restarted scanner reports with an empty failure memory;
            // absence must not read as recovery. Only an upload clears.
            await post(report({ scanFailures: [authFailure] }));
            await post(report());

            const image = await imageRow(DIGEST_A);
            expect(image.lastScanErrorCode).toBe("registry_auth");
        });

        it("is cleared by a successful SBOM upload for the digest", async () => {
            await post(report({ scanFailures: [authFailure] }));

            const upload = await request(app)
                .post(`/api/sboms/upload/cyclonedx?imageDigest=${DIGEST_A}`)
                .set(createApiKeyHeaders(clusterKey))
                .send({
                    bomFormat: "CycloneDX",
                    specVersion: "1.6",
                    version: 1,
                    metadata: {
                        timestamp: "2026-08-25T00:00:00Z",
                        component: { type: "application", name: "api", version: "1.4.2" },
                    },
                    components: [
                        { type: "library", name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21" },
                    ],
                });
            expect(upload.status).toBe(201);

            const image = await imageRow(DIGEST_A);
            expect(image.lastScanErrorCode).toBeNull();
            expect(image.lastScanErrorHost).toBeNull();
            expect(image.lastScanErrorAt).toBeNull();
        });

        it("drops a failure whose digest no container in the report carries", async () => {
            const res = await post(report({
                scanFailures: [{ ...authFailure, imageDigest: DIGEST_B }],
            }));
            expect(res.status).toBe(200);

            const rows = await getTestDb()
                .select()
                .from(schema.images)
                .where(eq(schema.images.digest, DIGEST_B));
            expect(rows).toHaveLength(0);
        });

        it("stores an unknown snake_case code rather than rejecting the report", async () => {
            // The code set is open: a newer scanner may add one, and the UI
            // renders what it does not recognise as a generic failure.
            const res = await post(report({
                scanFailures: [{ ...authFailure, code: "registry_teapot" }],
            }));
            expect(res.status).toBe(200);
            expect((await imageRow(DIGEST_A)).lastScanErrorCode).toBe("registry_teapot");
        });

        it("rejects anything shaped like raw stderr in the code or host", async () => {
            // The schema is what enforces "raw syft stderr never leaves the
            // scanner": free text cannot land in these columns.
            const stderrish = await post(report({
                scanFailures: [{ ...authFailure, code: "GET https://api.digitalocean.com 401" }],
            }));
            expect(stderrish.status).toBe(400);

            const hostish = await post(report({
                scanFailures: [{ ...authFailure, registryHost: "host with spaces and \"quotes\"" }],
            }));
            expect(hostish.status).toBe(400);
        });
    });

    describe("coverage", () => {
        /**
         * `scanned <= discovered` holds by construction now: both numbers come
         * from one `LEFT JOIN` over `workload_containers`, not from two counts
         * over two populations.
         */
        it("reports discovered and scanned from one join", async () => {
            const db = getTestDb();
            await post(report({
                namespaces: [{
                    name: "default",
                    labels: {},
                    workloads: [
                        workload(),
                        workload({
                            name: "web",
                            containers: [container({ imageDigest: DIGEST_B, imageRef: `ghcr.io/acme/api@${DIGEST_B}` })],
                        }),
                    ],
                }],
            }));

            const [imageA] = await db
                .select()
                .from(schema.images)
                .where(eq(schema.images.digest, DIGEST_A));
            await createSbom(db, { imageId: imageA!.id });

            const res = await request(app)
                .get(`/api/clusters/${clusterId}/coverage`)
                .set(createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                    orgName: testData.org.name,
                    orgSlug: testData.org.slug,
                }));

            expect(res.status).toBe(200);
            expect(res.body.discovered).toBe(2);
            expect(res.body.scanned).toBe(1);
            expect(res.body.scanned).toBeLessThanOrEqual(res.body.discovered);
            expect(res.body.workloads).toHaveLength(1);
            expect(res.body.workloads[0].workloadName).toBe("web");
        });

        it("counts a shared image as covering every container that runs it", async () => {
            const db = getTestDb();
            const image = await createImage(db, testData.org.id, clusterId, { digest: DIGEST_A });
            await createSbom(db, { imageId: image.id });

            await post(report({
                namespaces: ["a", "b", "c"].map((name) => ({ name, labels: {}, workloads: [workload()] })),
            }));

            const res = await request(app)
                .get(`/api/clusters/${clusterId}/coverage`)
                .set(createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                    orgName: testData.org.name,
                    orgSlug: testData.org.slug,
                }));

            expect(res.body.discovered).toBe(3);
            expect(res.body.scanned).toBe(3);
            expect(res.body.workloads).toEqual([]);
        });
    });
});

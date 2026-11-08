import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createOrgWithOwner,
    createImage,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import { FINDINGS_CSV_COLUMNS } from "../../../src/lib/findings-csv.js";

type Column = (typeof FINDINGS_CSV_COLUMNS)[number];

/**
 * `?format=csv` on the three vulnerability lists — organization, cluster,
 * image. The file is the view: the same scope and filters as the JSON page,
 * but every finding the headline badge counts, one row each, rather than a
 * page of advisories. Nothing from another org is ever in it, and the
 * filename names the scope.
 */
describe("findings CSV export", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb(), {}, { slug: "acme-corp" });
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

    /** RFC 4180 reader enough for what the export writes: quoted cells, doubled quotes, CRLF. */
    function parseCsv(body: string): string[][] {
        expect(body.startsWith("\uFEFF")).toBe(true);
        const text = body.slice(1);
        expect(text.endsWith("\r\n")).toBe(true);
        const rows: string[][] = [];
        let cell = "";
        let row: string[] = [];
        let quoted = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i]!;
            if (quoted) {
                if (ch === '"' && text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else if (ch === '"') {
                    quoted = false;
                } else {
                    cell += ch;
                }
            } else if (ch === '"') {
                quoted = true;
            } else if (ch === ",") {
                row.push(cell);
                cell = "";
            } else if (ch === "\r" && text[i + 1] === "\n") {
                row.push(cell);
                rows.push(row);
                row = [];
                cell = "";
                i++;
            } else {
                cell += ch;
            }
        }
        return rows;
    }

    /** The data rows as objects keyed by header, after checking the header is the column list. */
    function records(body: string): Record<Column, string>[] {
        const [header, ...rows] = parseCsv(body);
        expect(header).toEqual([...FINDINGS_CSV_COLUMNS]);
        return rows.map((cells) => {
            expect(cells).toHaveLength(FINDINGS_CSV_COLUMNS.length);
            return Object.fromEntries(FINDINGS_CSV_COLUMNS.map((column, i) => [column, cells[i]])) as Record<
                Column,
                string
            >;
        });
    }

    async function component(sbomId: string, name: string, version: string) {
        const [c] = await getTestDb()
            .insert(schema.components)
            .values({
                sbomId,
                name,
                version,
                purl: `pkg:npm/${name}@${version}`,
                type: "library",
                isDirect: true,
            })
            .returning();
        return c!;
    }

    async function advisory(values: {
        vulnId: string;
        severityLevel?: string | null;
        cvssScore?: number | null;
        epssScore?: number | null;
        kevListedAt?: Date | null;
        kevDueDate?: Date | null;
        publishedAt?: Date | null;
        summary?: string | null;
    }) {
        const [vuln] = await getTestDb()
            .insert(schema.vulnerabilities)
            .values(
                withFindingIdentity([
                    {
                        vulnId: values.vulnId,
                        source: "osv",
                        severityLevel: values.severityLevel ?? null,
                        cvssScore: values.cvssScore ?? null,
                        epssScore: values.epssScore ?? null,
                        kevListedAt: values.kevListedAt ?? null,
                        kevDueDate: values.kevDueDate ?? null,
                        publishedAt: values.publishedAt ?? null,
                        summary: values.summary ?? null,
                    },
                ]),
            )
            .returning();
        return vuln!;
    }

    async function finding(
        componentId: string,
        vulnerabilityId: string,
        fixedVersion: string | null = null,
        matchConfidence: "exact" | "fuzzy" | "unconfirmed" = "exact",
    ) {
        await getTestDb().insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence,
            fixedVersion,
        });
    }

    /**
     * Two clusters. Cluster A runs `api` (lodash + react) in `payments`;
     * cluster B runs `worker` (lodash) in `jobs`. One KEV critical on lodash
     * in both, one high on react with no fix, one unconfirmed match that must
     * not appear.
     */
    async function seedFleet() {
        const db = getTestDb();
        const { org, cluster: clusterA } = testData;
        const clusterB = await createCluster(db, org.id, { name: "prod EU / west" });

        const imageA = await createImage(db, org.id, clusterA.id, {
            digest: "sha256:" + "a".repeat(64),
            registry: "ghcr.io",
            repository: "acme/api",
        });
        const imageB = await createImage(db, org.id, clusterB.id, {
            digest: "sha256:" + "b".repeat(64),
            repository: "acme/worker",
        });
        await seedRunningImage(db, org.id, clusterA.id, { image: imageA, namespace: "payments", workloadName: "api" });
        await seedRunningImage(db, org.id, clusterB.id, { image: imageB, namespace: "jobs", workloadName: "worker" });
        const sbomA = await createSbom(db, { imageId: imageA.id });
        const sbomB = await createSbom(db, { imageId: imageB.id });

        const lodashA = await component(sbomA.id, "lodash", "4.17.20");
        const lodashB = await component(sbomB.id, "lodash", "4.17.20");
        const reactA = await component(sbomA.id, "react", "18.0.0");

        const kev = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
            epssScore: 0.9731,
            kevListedAt: new Date("2024-03-01T00:00:00Z"),
            kevDueDate: new Date("2024-03-22T00:00:00Z"),
            publishedAt: new Date("2024-02-10T12:00:00Z"),
            summary: 'Prototype pollution, see "notes"',
        });
        const high = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high", cvssScore: 7.5 });
        const unconfirmed = await advisory({ vulnId: "CVE-2024-0003", severityLevel: "critical", cvssScore: 9.1 });

        await finding(lodashA.id, kev.id, "4.17.21");
        await finding(lodashB.id, kev.id, "4.17.21");
        await finding(reactA.id, high.id);
        await finding(reactA.id, unconfirmed.id, null, "unconfirmed");

        return { clusterA, clusterB, imageA, imageB };
    }

    it("downloads every finding of the organization, one row each, KEV first, as an attachment", async () => {
        const { clusterA } = await seedFleet();

        const res = await request(app).get("/api/vulnerabilities?format=csv").set(authHeaders());

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
        expect(res.headers["content-disposition"]).toMatch(
            /^attachment; filename="stackradar-findings-acme-corp-\d{4}-\d{2}-\d{2}\.csv"$/,
        );

        const rows = records(res.text);
        expect(rows).toHaveLength(3);

        // The KEV critical on both clusters' lodash comes first, one row per
        // image; the two rows are ordered by cluster name, which the
        // database's collation decides, so they are found by image here.
        const kevRows = rows.slice(0, 2);
        const onApi = kevRows.find((r) => r.image === "ghcr.io/acme/api");
        const onWorker = kevRows.find((r) => r.image === "ghcr.io/acme/worker");
        expect(onApi).toMatchObject({
            vulnerability: "CVE-2024-0001",
            severity: "critical",
            cvss: "9.8",
            epss: "0.9731",
            kev: "true",
            kev_due_date: "2024-03-22",
            package: "lodash",
            installed_version: "4.17.20",
            fixed_version: "4.17.21",
            package_type: "npm",
            layer: "unclassified",
            cluster: clusterA.name,
            digest: "sha256:" + "a".repeat(64),
            namespaces: "payments",
            published: "2024-02-10",
            matched_advisory: "CVE-2024-0001",
            summary: 'Prototype pollution, see "notes"',
        });
        expect(Number(onApi!.risk_score)).toBeGreaterThan(0);
        expect(onWorker).toMatchObject({
            vulnerability: "CVE-2024-0001",
            cluster: "prod EU / west",
            digest: "sha256:" + "b".repeat(64),
            namespaces: "jobs",
        });
        // The high on react: no fix, no KEV, no EPSS — empty cells, not "null".
        expect(rows[2]).toMatchObject({
            vulnerability: "CVE-2024-0002",
            severity: "high",
            kev: "false",
            kev_due_date: "",
            epss: "",
            fixed_version: "",
            package: "react",
            summary: "",
        });
    });

    it("applies the list's filters, and ignores paging — the file is the whole view", async () => {
        await seedFleet();

        const high = await request(app).get("/api/vulnerabilities?format=csv&severity=high").set(authHeaders());
        expect(records(high.text).map((r) => r.vulnerability)).toEqual(["CVE-2024-0002"]);

        const kev = await request(app).get("/api/vulnerabilities?format=csv&kev=true").set(authHeaders());
        expect(records(kev.text).map((r) => r.package)).toEqual(["lodash", "lodash"]);

        const searched = await request(app).get("/api/vulnerabilities?format=csv&search=react").set(authHeaders());
        expect(records(searched.text).map((r) => r.package)).toEqual(["react"]);

        const paged = await request(app).get("/api/vulnerabilities?format=csv&limit=1&offset=1").set(authHeaders());
        expect(records(paged.text)).toHaveLength(3);
    });

    it("narrows to a cluster or a namespace exactly as the page does", async () => {
        const { clusterA, clusterB } = await seedFleet();

        const byCluster = await request(app)
            .get(`/api/vulnerabilities?format=csv&cluster=${clusterB.id}`)
            .set(authHeaders());
        expect(records(byCluster.text).map((r) => [r.vulnerability, r.cluster])).toEqual([
            ["CVE-2024-0001", "prod EU / west"],
        ]);

        const byNamespace = await request(app)
            .get("/api/vulnerabilities?format=csv&namespace=payments")
            .set(authHeaders());
        expect(records(byNamespace.text).map((r) => r.cluster)).toEqual([clusterA.name, clusterA.name]);
    });

    it("exports one cluster's findings from its own list, named after the cluster", async () => {
        const { clusterB } = await seedFleet();

        const res = await request(app)
            .get(`/api/clusters/${clusterB.id}/vulnerabilities?format=csv`)
            .set(authHeaders());

        expect(res.status).toBe(200);
        expect(res.headers["content-disposition"]).toMatch(
            /^attachment; filename="stackradar-findings-prod-EU-west-\d{4}-\d{2}-\d{2}\.csv"$/,
        );
        expect(records(res.text).map((r) => [r.vulnerability, r.image])).toEqual([
            ["CVE-2024-0001", "ghcr.io/acme/worker"],
        ]);
    });

    it("exports one image's findings from its own list, named after the image", async () => {
        const { imageA } = await seedFleet();

        const res = await request(app).get(`/api/images/${imageA.id}/vulnerabilities?format=csv`).set(authHeaders());

        expect(res.status).toBe(200);
        expect(res.headers["content-disposition"]).toMatch(
            /^attachment; filename="stackradar-findings-api-aaaaaaaa-\d{4}-\d{2}-\d{2}\.csv"$/,
        );
        expect(records(res.text).map((r) => r.vulnerability)).toEqual(["CVE-2024-0001", "CVE-2024-0002"]);
    });

    it("never carries another org's findings, and 404s for another org's image", async () => {
        const { imageA } = await seedFleet();
        const other = await createOrgWithOwner(getTestDb());
        const otherHeaders = createInternalHeaders({
            id: other.user.id,
            email: other.user.email,
            orgId: other.org.id,
            orgName: other.org.name,
            orgSlug: other.org.slug,
        });

        const orgWide = await request(app).get("/api/vulnerabilities?format=csv").set(otherHeaders);
        expect(orgWide.status).toBe(200);
        expect(records(orgWide.text)).toEqual([]);

        const image = await request(app).get(`/api/images/${imageA.id}/vulnerabilities?format=csv`).set(otherHeaders);
        expect(image.status).toBe(404);
    });

    it("is a header alone for a scope with no findings, and leaves the JSON page as it was", async () => {
        const empty = await request(app).get("/api/vulnerabilities?format=csv").set(authHeaders());
        expect(empty.status).toBe(200);
        expect(records(empty.text)).toEqual([]);

        const page = await request(app).get("/api/vulnerabilities?format=json").set(authHeaders());
        expect(page.status).toBe(200);
        expect(page.headers["content-type"]).toMatch(/^application\/json/);
        expect(page.body).toMatchObject({ vulnerabilities: [], total: 0 });
    });
});

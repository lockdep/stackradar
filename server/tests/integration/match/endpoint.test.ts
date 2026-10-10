/**
 * `POST /internal/match` against a real database and a miniature mirror.
 *
 * The shape assertions run the response through `docs/contracts/match-endpoint.json`
 * — the same file the charts app validates its recorded fixtures against —
 * so a field added to the response without landing in the contract fails
 * here first.
 */

// Both read by `config` at import time; the app is imported lazily below.
process.env.MATCH_SERVICE_KEY = "test-match-key";
process.env.MATCH_MAX_COMPONENTS = "50";

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { getTestApp } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import {
    EXPECTED_FINDING_KEYS,
    KEV_LISTED_AT,
    PUBLISHED,
    MIRROR_COMPONENTS,
    seedMatchMirror,
    type SeededMirror,
} from "./mirror-fixture.js";
import { eq } from "drizzle-orm";

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const CONTRACT = JSON.parse(
    readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/contracts/match-endpoint.json"),
        "utf-8"
    )
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateResponse = ajv.compile(CONTRACT);

const KEY = { "X-Match-Key": "test-match-key" };

type Finding = {
    component: number;
    vulnId: string;
    findingIdentity: string;
    aliases: string[];
    severityLevel: string;
    cvssScore: number | null;
    kevListedAt: string | null;
    publishedAt: string | null;
    risk: number;
    packageName: string;
    purlType: string | null;
    fixedVersion: string | null;
    confidence: string;
};

let app: Express;
let mirror: SeededMirror;

beforeAll(async () => {
    app = await getTestApp();
});

beforeEach(async () => {
    await cleanAllData();
    mirror = await seedMatchMirror(getTestDb());
});

// Single-row state tables that `cleanAllData` leaves alone.
afterEach(async () => {
    await getTestDb().delete(schema.osvSyncState);
});

type RequestComponent = { name: string; purl?: string | null; version?: string | null };

async function match(components: RequestComponent[] = MIRROR_COMPONENTS) {
    return request(app).post("/internal/match").set(KEY).send({ components });
}

describe("authentication", () => {
    it("401 without a key", async () => {
        const res = await request(app).post("/internal/match").send({ components: MIRROR_COMPONENTS });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: "unauthorized" });
    });

    it("401 with the wrong key, and with the internal service key", async () => {
        const wrong = await request(app)
            .post("/internal/match")
            .set({ "X-Match-Key": "not-the-key" })
            .send({ components: MIRROR_COMPONENTS });
        expect(wrong.status).toBe(401);

        const internal = await request(app)
            .post("/internal/match")
            .set({ "X-Match-Key": process.env.INTERNAL_SERVICE_KEY! })
            .send({ components: MIRROR_COMPONENTS });
        expect(internal.status).toBe(401);
    });
});

describe("request validation", () => {
    it("413 above MATCH_MAX_COMPONENTS, naming the cap", async () => {
        const components = Array.from({ length: 51 }, (_, i) => ({ name: `pkg-${i}` }));
        const res = await match(components);
        expect(res.status).toBe(413);
        expect(res.body).toEqual({ error: "too_many_components", max: 50 });
    });

    it("422 on an empty or malformed body", async () => {
        const empty = await match([]);
        expect(empty.status).toBe(422);
        expect(empty.body.error).toBe("invalid_body");
        expect(empty.body.issues[0].path).toBe("components");

        const malformed = await request(app).post("/internal/match").set(KEY).send({ purls: [] });
        expect(malformed.status).toBe(422);
    });
});

describe("mirror gate", () => {
    it("503 while the OSV mirror has never completed its initial import", async () => {
        await getTestDb()
            .insert(schema.osvSyncState)
            .values({ id: 1, initialized: false, syncStatus: "bootstrapping" });

        const res = await match();
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "matching_unavailable" });
    });

    it("answers once the mirror is initialised", async () => {
        await getTestDb()
            .insert(schema.osvSyncState)
            .values({ id: 1, initialized: true, syncStatus: "idle" });

        const res = await match();
        expect(res.status).toBe(200);
    });
});

describe("200 response", () => {
    it("matches the contract's JSON schema", async () => {
        const res = await match();
        expect(res.status).toBe(200);

        const valid = validateResponse(res.body);
        expect(validateResponse.errors ?? []).toEqual([]);
        expect(valid).toBe(true);
        expect(res.body.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
        expect(new Date(res.body.matchedAt).getTime()).toBeGreaterThan(0);
    });

    it("returns the product's finding set: counted, collapsed, folded, withdrawn dropped", async () => {
        const res = await match();
        const findings: Finding[] = res.body.findings;

        const keys = findings
            .map((f) => `${f.purlType}|${f.packageName}|${f.findingIdentity}`)
            .sort();
        expect(keys).toEqual(EXPECTED_FINDING_KEYS);

        // Rule 2: nothing unconfirmed leaves the endpoint.
        for (const f of findings) expect(["exact", "fuzzy"]).toContain(f.confidence);
        expect(findings.map((f) => f.vulnId)).not.toContain("CVE-2024-0003");

        // Withdrawn advisory absent.
        expect(findings.map((f) => f.vulnId)).not.toContain("CVE-2024-0004");

        // Past the fix: absent.
        expect(findings.map((f) => f.vulnId)).not.toContain("CVE-2024-0006");
    });

    it("collapses a deb binary and its source package to one row named after the source, folding the DSA", async () => {
        const res = await match();
        const findings: Finding[] = res.body.findings;

        const debian = findings.filter((f) => f.purlType === "deb");
        expect(debian).toHaveLength(1);
        const [f] = debian;
        expect(f!.vulnId).toBe("CVE-2024-0002");
        expect(f!.packageName).toBe("openssl");
        // The primary is one of the two binaries; both are components 1 and 2.
        expect([1, 2]).toContain(f!.component);
        // Rule 5: the notice is folded, and named among the aliases.
        expect(findings.map((x) => x.vulnId)).not.toContain("DSA-5678-1");
        expect(f!.aliases).toContain("DSA-5678-1");
        expect(f!.fixedVersion).toBe("3.0.11-1~deb12u3");
        // The CVE's own date, not the later notice's.
        expect(f!.publishedAt).toBe(PUBLISHED.at["CVE-2024-0002"]!.toISOString());
    });

    it("collapses a GHSA and a GO- record for one CVE, keeping the scored one", async () => {
        const res = await match();
        const findings: Finding[] = res.body.findings;

        const go = findings.filter((f) => f.purlType === "golang");
        expect(go).toHaveLength(1);
        const [f] = go;
        expect(f!.vulnId).toBe("GHSA-aaaa-bbbb-cccc");
        expect(f!.findingIdentity).toBe("CVE-2024-0005");
        expect(f!.component).toBe(3);
        expect(f!.severityLevel).toBe("critical");
        expect(f!.aliases).toEqual(["CVE-2024-0005", "GO-2024-0001"]);
        expect(f!.fixedVersion).toBe("1.3.0");
        // The earliest across the set: the folded GO- record predates the primary GHSA.
        expect(f!.publishedAt).toBe(PUBLISHED.at["GO-2024-0001"]!.toISOString());
    });

    it("reports the seeded row's generated risk_score and KEV date, never a recomputation", async () => {
        const db = getTestDb();
        const [row] = await db
            .select({ riskScore: schema.vulnerabilities.riskScore })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.id, mirror.ids["CVE-2024-0001"]!));
        expect(row!.riskScore).toBeGreaterThan(0);

        const res = await match();
        const f = (res.body.findings as Finding[]).find((x) => x.vulnId === "CVE-2024-0001")!;
        expect(f.risk).toBe(row!.riskScore);
        expect(f.kevListedAt).toBe(KEV_LISTED_AT.toISOString());
        expect(f.publishedAt).toBe(PUBLISHED.at["CVE-2024-0001"]!.toISOString());
        expect(f.component).toBe(0);
        expect(f.packageName).toBe("openssl");
        expect(f.fixedVersion).toBe("3.1.5-r0");
    });

    it("orders by risk descending, then vulnId", async () => {
        const res = await match();
        const findings: Finding[] = res.body.findings;
        for (let i = 1; i < findings.length; i++) {
            const a = findings[i - 1]!;
            const b = findings[i]!;
            expect(a.risk > b.risk || (a.risk === b.risk && a.vulnId <= b.vulnId)).toBe(true);
        }
    });

    it("carries the three sync watermarks, null on a fresh mirror", async () => {
        const fresh = await match();
        expect(fresh.body.sync).toEqual({ osvSyncedAt: null, epssScoreDate: null, kevCatalogVersion: null });

        const db = getTestDb();
        const polledAt = new Date("2026-09-02T04:31:10.000Z");
        await db.insert(schema.osvSyncState).values({
            id: 1,
            initialized: true,
            syncStatus: "idle",
            initCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
            lastSuccessfulPollAt: polledAt,
        });
        await db.insert(schema.epssSyncState).values({ id: 1, lastScoreDate: "2026-09-01" });
        await db.insert(schema.kevSyncState).values({ id: 1, catalogVersion: "2026.09.01" });

        const synced = await match();
        expect(synced.body.sync).toEqual({
            osvSyncedAt: polledAt.toISOString(),
            epssScoreDate: "2026-09-01",
            kevCatalogVersion: "2026.09.01",
        });
    });

    it("stores nothing", async () => {
        const db = getTestDb();
        await match();
        const links = await db.select().from(schema.componentVulnerabilities);
        const components = await db.select().from(schema.components);
        const images = await db.select().from(schema.images);
        expect(links).toHaveLength(0);
        expect(components).toHaveLength(0);
        expect(images).toHaveLength(0);
    });
});

describe("mounting", () => {
    afterAll(() => {
        process.env.MATCH_SERVICE_KEY = "test-match-key";
        vi.resetModules();
    });

    it("is not mounted at all when MATCH_SERVICE_KEY is unset", async () => {
        delete process.env.MATCH_SERVICE_KEY;
        vi.resetModules();
        const { default: unkeyedApp } = await import("../../../src/app.js");

        const res = await request(unkeyedApp)
            .post("/internal/match")
            .set(KEY)
            .send({ components: MIRROR_COMPONENTS });
        expect(res.status).toBe(404);
    });
});

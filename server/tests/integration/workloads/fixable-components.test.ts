/**
 * "3 packages to bump" — the number the workloads list filters on.
 *
 * It is a count of *components*, not of findings, and that is the whole point:
 * one `openssl` bump closes every advisory sitting on `openssl`, so a finding
 * count describes an afternoon of work that does not exist. These tests pin the
 * three ways that number could quietly become dishonest — counting a component
 * twice, counting a fix nobody stated, and counting a match the matcher never
 * confirmed.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createSbom,
    createImage,
    withFindingIdentity,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

type Seeded = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
    const db = getTestDb();
    const { user, org, cluster } = await seedTestScenario(db);

    const scannedImage = await createImage(db, org.id, cluster.id, { digest: `sha256:${"c".repeat(64)}` });
    const { container: scanned } = await seedRunningImage(db, org.id, cluster.id, {
        workloadName: "api",
        containerName: "app",
        image: scannedImage,
    });
    const sbom = await createSbom(db, { imageId: scannedImage.id });

    // A second container on an image nobody has scanned — the null case.
    const { container: unscanned } = await seedRunningImage(db, org.id, cluster.id, {
        workloadName: "worker",
        containerName: "app",
    });

    const component = async (name: string, version: string) => {
        const [c] = await db
            .insert(schema.components)
            .values({
                sbomId: sbom.id,
                name,
                version,
                purl: `pkg:generic/${name}@${version}`,
                type: "library",
                isDirect: true,
            })
            .returning();
        return c!;
    };

    const advisory = async (vulnId: string, severityLevel: string, cvssScore: number) => {
        const [v] = await db
            .insert(schema.vulnerabilities)
            .values(withFindingIdentity([{ vulnId, source: "osv", severityLevel, cvssScore, aliases: null }]))
            .returning();
        return v!;
    };

    const link = async (
        componentId: string,
        vulnerabilityId: string,
        matchConfidence: "exact" | "fuzzy" | "unconfirmed",
        fixedVersion: string | null,
    ) => {
        await db.insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence,
            fixedVersion,
        });
    };

    // 1. One component, two fixable findings. Bumping it once closes both, so
    //    it is one package to bump — not two.
    const openssl = await component("openssl", "3.0.1");
    await link(openssl.id, (await advisory("CVE-2024-1001", "critical", 9.8)).id, "exact", "3.0.2");
    await link(openssl.id, (await advisory("CVE-2024-1002", "high", 7.5)).id, "exact", "3.0.3");

    // 2. A real finding whose advisory states no fix. Nothing to bump — and the
    //    presence of this row is what makes the image *scanned*, so a zero here
    //    is a measurement rather than a shrug.
    const zlib = await component("zlib", "1.2.11");
    await link(zlib.id, (await advisory("CVE-2024-2001", "medium", 5.4)).id, "exact", null);

    // 3. A fix version on a match the matcher never confirmed. The package
    //    matched; the version question went unanswered. Offering a bump on the
    //    strength of that is offering work we cannot say is needed.
    const curl = await component("curl", "8.0.0");
    await link(curl.id, (await advisory("CVE-2024-3001", "critical", 9.1)).id, "unconfirmed", "8.1.0");

    return { db, user, org, scanned, unscanned };
}

describe("fixableComponents on the workloads list", () => {
    let app: Express;
    let seeded: Seeded;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        seeded = await seedFixture();
    });

    function authHeaders() {
        const { user, org } = seeded;
        return createInternalHeaders({
            id: user.id,
            email: user.email,
            orgId: org.id,
            orgName: org.name,
            orgSlug: org.slug,
        });
    }

    async function rows() {
        const res = await request(app).get("/api/containers").set(authHeaders());
        expect(res.status).toBe(200);
        return res.body as { id: string; fixableComponents: number | null }[];
    }

    it("counts distinct packages, not findings", async () => {
        const row = (await rows()).find((w) => w.id === seeded.scanned.id);
        // openssl only: two advisories on it, one bump. zlib states no fix and
        // curl's match was never confirmed.
        expect(row!.fixableComponents).toBe(1);
    });

    it("is null for an image nobody has scanned, never zero", async () => {
        const row = (await rows()).find((w) => w.id === seeded.unscanned.id);
        // Zero would put "we checked and there is nothing to bump" and "we have
        // never opened this image" in the same bucket, and the filter that
        // reads this number would then hide the second kind forever.
        expect(row!.fixableComponents).toBeNull();
    });

    it("reports zero once every fixable finding is gone", async () => {
        const db = getTestDb();
        // Strip the fix versions rather than the rows: the image stays scanned,
        // so this is the "we looked, nothing to bump" state and not the null one.
        await db.update(schema.componentVulnerabilities).set({ fixedVersion: null });

        const row = (await rows()).find((w) => w.id === seeded.scanned.id);
        expect(row!.fixableComponents).toBe(0);
    });
});

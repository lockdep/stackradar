/**
 * `finding.kev-listed` (`services/kev-listing.service.ts`): when CISA lists
 * an advisory that is already a confirmed finding on a running image, the
 * org gets one event naming the images — the alert worker's input for the
 * case no rescan can see.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, seedRunningImage, createImage, createSbom, withFindingIdentity, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

async function service() {
    return import("../../../src/services/kev-listing.service.js");
}
async function kevRepository() {
    return (await import("../../../src/kev-sync/repository.js")).createKevRepository();
}

const SYNCED = { lastSyncedAt: new Date("2026-09-25T06:15:00Z") };

describe("KEV listings on running images", () => {
    let seeded: SeedTestScenarioResult;

    beforeEach(async () => {
        await cleanAllData();
        seeded = await seedTestScenario(getTestDb(), {}, { plan: "pro" });
    });

    /** A confirmed (or not) finding of `vuln` on `imageId`. */
    async function finding(imageId: string, vulnId: string, opts: { confidence?: "exact" | "unconfirmed"; name?: string } = {}) {
        const db = getTestDb();
        const sbom = await createSbom(db, { imageId });
        const [component] = await db
            .insert(schema.components)
            .values({ sbomId: sbom.id, name: opts.name ?? "glibc", version: "2.36", purl: `pkg:deb/debian/${opts.name ?? "glibc"}@2.36`, type: "library", isDirect: true })
            .returning();
        const [existing] = await db.select().from(schema.vulnerabilities).where(eq(schema.vulnerabilities.vulnId, vulnId));
        const vuln =
            existing ??
            (await db
                .insert(schema.vulnerabilities)
                .values(withFindingIdentity([{ vulnId, source: "osv", severityLevel: "high", cvssScore: 8.1 }]))
                .returning())[0]!;
        await db.insert(schema.componentVulnerabilities).values({
            componentId: component!.id,
            vulnerabilityId: vuln.id,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: opts.confidence ?? "exact",
            fixedVersion: "2.37",
        });
        return vuln;
    }

    it("writes one event per (org, advisory) with the running images in the payload", async () => {
        const db = getTestDb();
        const a = await seedRunningImage(db, seeded.org.id, seeded.cluster.id, { namespace: "prod", workloadName: "api" });
        const b = await seedRunningImage(db, seeded.org.id, seeded.cluster.id, { namespace: "prod", workloadName: "web", digest: "sha256:" + "b".repeat(64) });
        const vuln = await finding(a.image.id, "CVE-2026-7777");
        await finding(b.image.id, "CVE-2026-7777");
        // A second org running nothing affected.
        const other = await seedTestScenario(db, { email: "other@test.com" }, { plan: "free", slug: "other" });
        const otherImage = await seedRunningImage(db, other.org.id, other.cluster.id);
        await finding(otherImage.image.id, "CVE-2026-0001");

        const { recordKevListings } = await service();
        const stats = await recordKevListings([{ id: vuln.id, vulnId: vuln.vulnId }], SYNCED);

        expect(stats).toMatchObject({ listed: 1, running: 1, events: 1, orgs: 1 });
        const events = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.type, "finding.kev-listed"));
        expect(events).toHaveLength(1);
        const [event] = events;
        expect(event!.orgId).toBe(seeded.org.id);
        expect(event!.imageId).toBeNull();
        const payload = event!.payload as { vulnId: string; imageCount: number; packages: string[]; fixedVersion: string; images: Array<{ imageId: string; containerCount: number; containers: Array<{ namespace: string; workloadName: string }> }> };
        expect(payload.vulnId).toBe("CVE-2026-7777");
        expect(payload.imageCount).toBe(2);
        expect(payload.packages).toEqual(["glibc@2.36"]);
        expect(payload.fixedVersion).toBe("2.37");
        expect(payload.images.map((i) => i.imageId).sort()).toEqual([a.image.id, b.image.id].sort());
        expect(payload.images[0]!.containerCount).toBe(1);
        expect(payload.images[0]!.containers[0]).toMatchObject({ namespace: "prod" });
    });

    it("says nothing for an image nothing runs, an unconfirmed match, or a first run", async () => {
        const db = getTestDb();
        const idle = await createImage(db, seeded.org.id, seeded.cluster.id);
        await db.update(schema.images).set({ firstSeenAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(schema.images.id, idle.id));
        const idleVuln = await finding(idle.id, "CVE-2026-1111");
        const running = await seedRunningImage(db, seeded.org.id, seeded.cluster.id);
        const unconfirmed = await finding(running.image.id, "CVE-2026-2222", { confidence: "unconfirmed", name: "zlib" });

        const { recordKevListings } = await service();
        const listed = [
            { id: idleVuln.id, vulnId: idleVuln.vulnId },
            { id: unconfirmed.id, vulnId: unconfirmed.vulnId },
        ];
        expect(await recordKevListings(listed, SYNCED)).toMatchObject({ events: 0 });
        expect(await recordKevListings(listed, { lastSyncedAt: null })).toMatchObject({ skipped: "first-run", events: 0 });
        expect(await db.select().from(schema.activityEvents)).toHaveLength(0);
    });

    it("the KEV apply reports which advisories were listed for the first time", async () => {
        const db = getTestDb();
        await db.insert(schema.vulnerabilities).values(withFindingIdentity([
            { vulnId: "CVE-2021-44228", source: "osv", cvssScore: 10, severityLevel: "critical", aliases: [] },
            { vulnId: "CVE-2019-0708", source: "osv", cvssScore: 9.8, severityLevel: "critical", aliases: [], kevListedAt: new Date("2019-05-14") },
        ]));
        const repo = await kevRepository();
        const result = await repo.apply(
            [
                { cve: "CVE-2021-44228", dateAdded: new Date("2021-12-10"), dueDate: null, ransomware: "Known" },
                // Already listed: a changed due date is not news.
                { cve: "CVE-2019-0708", dateAdded: new Date("2019-05-14"), dueDate: new Date("2022-05-03"), ransomware: "Unknown" },
            ],
            { minEntries: 1 }
        );
        expect(result.advisoriesListed).toBe(2);
        expect(result.newlyListed).toEqual([{ id: expect.any(String), vulnId: "CVE-2021-44228" }]);
    });
});

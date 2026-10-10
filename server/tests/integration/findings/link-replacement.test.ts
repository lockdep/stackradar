/**
 * A rescan replaces a component's findings; it does not add to them.
 *
 * The counts are taken from stored match verdicts, which only works if a
 * verdict can be withdrawn. The mirror is not static — advisories get corrected,
 * withdrawn, or re-scoped to a release the component is not on — so a link
 * table that only ever grows reports a workload as vulnerable to things that
 * have since been retracted, and the number can never come down.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, createImage, createSbom, withFindingIdentity } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

async function seedTwoLinkedAdvisories() {
    const db = getTestDb();
    const { org, cluster } = await seedTestScenario(db);
    const image = await createImage(db, org.id, cluster.id);
    const sbom = await createSbom(db, { imageId: image.id });

    const [component] = await db
        .insert(schema.components)
        .values({ sbomId: sbom.id, name: "lodash", version: "4.17.20", type: "library" })
        .returning();
    const [other] = await db
        .insert(schema.components)
        .values({ sbomId: sbom.id, name: "express", version: "4.18.0", type: "library" })
        .returning();

    const advisories = await db
        .insert(schema.vulnerabilities)
        .values(withFindingIdentity([
            { vulnId: "CVE-2024-0001", source: "osv", severityLevel: "high" },
            { vulnId: "CVE-2024-0002", source: "osv", severityLevel: "high" },
        ]))
        .returning();

    await db.insert(schema.componentVulnerabilities).values(
        advisories.map(v => ({
            componentId: component!.id,
            vulnerabilityId: v.id,
            matchedBy: "purl" as const,
            matchConfidence: "exact" as const,
        }))
    );
    await db.insert(schema.componentVulnerabilities).values({
        componentId: other!.id,
        vulnerabilityId: advisories[0]!.id,
        matchedBy: "purl",
        matchConfidence: "exact",
    });

    return { db, component: component!, other: other!, advisories };
}

async function linksFor(componentId: string): Promise<string[]> {
    const { db } = await import("../../../src/db/index.js");
    const { eq } = await import("drizzle-orm");
    const rows = await db
        .select({ vulnId: schema.vulnerabilities.vulnId })
        .from(schema.componentVulnerabilities)
        .innerJoin(
            schema.vulnerabilities,
            eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id)
        )
        .where(eq(schema.componentVulnerabilities.componentId, componentId));
    return rows.map(r => r.vulnId).sort();
}

describe("replaceComponentLinks", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("drops a link the rescan no longer reports", async () => {
        const { component, advisories } = await seedTwoLinkedAdvisories();
        const { vulnerabilityRepository } = await import(
            "../../../src/repositories/vulnerability.repository.js"
        );

        await vulnerabilityRepository.replaceComponentLinks(
            [component.id],
            [{
                componentId: component.id,
                vulnerabilityId: advisories[0]!.id,
                matchedBy: "purl",
                matchConfidence: "exact",
            }]
        );

        await expect(linksFor(component.id)).resolves.toEqual(["CVE-2024-0001"]);
    });

    it("drops every link when the rescan reports nothing", async () => {
        const { component } = await seedTwoLinkedAdvisories();
        const { vulnerabilityRepository } = await import(
            "../../../src/repositories/vulnerability.repository.js"
        );

        await vulnerabilityRepository.replaceComponentLinks([component.id], []);

        await expect(linksFor(component.id)).resolves.toEqual([]);
    });

    it("leaves components outside the rescanned batch alone", async () => {
        const { component, other, advisories } = await seedTwoLinkedAdvisories();
        const { vulnerabilityRepository } = await import(
            "../../../src/repositories/vulnerability.repository.js"
        );

        await vulnerabilityRepository.replaceComponentLinks([component.id], []);

        await expect(linksFor(other.id)).resolves.toEqual(["CVE-2024-0001"]);
        expect(advisories).toHaveLength(2);
    });

    it("updates the verdict on a link the rescan still reports", async () => {
        const { component, advisories } = await seedTwoLinkedAdvisories();
        const { vulnerabilityRepository } = await import(
            "../../../src/repositories/vulnerability.repository.js"
        );
        const { db } = await import("../../../src/db/index.js");
        const { and, eq } = await import("drizzle-orm");

        await vulnerabilityRepository.replaceComponentLinks(
            [component.id],
            [{
                componentId: component.id,
                vulnerabilityId: advisories[0]!.id,
                matchedBy: "purl",
                matchConfidence: "unconfirmed",
            }]
        );

        const [row] = await db
            .select({ confidence: schema.componentVulnerabilities.matchConfidence })
            .from(schema.componentVulnerabilities)
            .where(
                and(
                    eq(schema.componentVulnerabilities.componentId, component.id),
                    eq(schema.componentVulnerabilities.vulnerabilityId, advisories[0]!.id)
                )
            );
        expect(row!.confidence).toBe("unconfirmed");
    });
});

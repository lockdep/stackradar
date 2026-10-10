import { and, eq, inArray, isNotNull, min, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { collapsedFindings, deployedImages, findingIdentity, isCountedFinding } from "../db/findings.js";
import type { SlotRef } from "./container-history.repository.js";

/**
 * The reads behind exposure duration that are not history itself —
 * [exposure-duration-plan](../../../docs/exposure-duration-plan-2026-09-19.md).
 * Which slots run an affected image *now*, when we first observed their
 * clusters, and when the matcher first recorded the finding.
 */

/** A running slot, with what rule 5 of `lib/exposure.ts` needs from its workload. */
export interface RunningSlot extends SlotRef {
    workloadId: string;
    containerId: string;
    imageId: string;
    /** `workloads.first_started_at` — the earliest pod the informer currently sees. */
    workloadFirstStartedAt: Date | null;
}

async function runningSlots(orgId: string, where: SQL): Promise<RunningSlot[]> {
    return db
        .select({
            clusterId: schema.namespaces.clusterId,
            namespace: schema.namespaces.name,
            workloadName: schema.workloads.name,
            containerName: schema.workloadContainers.name,
            workloadId: schema.workloads.id,
            containerId: schema.workloadContainers.id,
            imageId: schema.workloadContainers.imageId,
            workloadFirstStartedAt: schema.workloads.firstStartedAt,
        })
        .from(schema.workloadContainers)
        .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
        .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
        .where(and(eq(schema.workloadContainers.orgId, orgId), where));
}

export const exposureRepository = {
    /** Every slot of the org currently running one of these images. */
    async runningSlotsOfImages(orgId: string, imageIds: string[]): Promise<RunningSlot[]> {
        if (imageIds.length === 0) return [];
        return runningSlots(orgId, inArray(schema.workloadContainers.imageId, imageIds));
    },

    /** The slot one container row occupies. */
    async runningSlotOfContainer(orgId: string, containerId: string): Promise<RunningSlot | undefined> {
        const [slot] = await runningSlots(orgId, eq(schema.workloadContainers.id, containerId));
        return slot;
    },

    /** Every slot of the org running an image that carries this advisory identity. */
    async runningSlotsForIdentity(orgId: string, identity: string): Promise<RunningSlot[]> {
        const findings = collapsedFindings(deployedImages(orgId));
        const affected = db
            .selectDistinct({ imageId: findings.imageId })
            .from(findings)
            .where(sql`${findings.identity} = ${identity}`);
        return runningSlots(orgId, inArray(schema.workloadContainers.imageId, affected));
    },

    /**
     * Slots that *used to* run an image carrying this identity: closed
     * intervals whose image still exists and still has the finding on
     * record. Whether what replaced it was clean is the walk's question
     * (`remediationWindows`), not this query's. Not limited to deployed
     * images — the image a fix replaced is, by definition, no longer running.
     */
    async formerSlotsForIdentity(orgId: string, identity: string, limit: number): Promise<SlotRef[]> {
        const findings = collapsedFindings(eq(schema.images.orgId, orgId));
        const carrying = db
            .selectDistinct({ imageId: findings.imageId })
            .from(findings)
            .where(sql`${findings.identity} = ${identity}`);
        const h = schema.workloadContainerHistory;
        return db
            .selectDistinct({
                clusterId: h.clusterId,
                namespace: h.namespace,
                workloadName: h.workloadName,
                containerName: h.containerName,
            })
            .from(h)
            .where(and(eq(h.orgId, orgId), isNotNull(h.endedAt), inArray(h.imageId, carrying)))
            .limit(limit);
    },

    /**
     * When the identity was first disclosed and first listed on KEV: the
     * earliest of each among its advisory records (a CVE and its GHSA).
     */
    async datesOfIdentity(identity: string): Promise<{ publishedAt: Date | null; kevListedAt: Date | null }> {
        const [row] = await db
            .select({
                publishedAt: min(schema.vulnerabilities.publishedAt),
                kevListedAt: min(schema.vulnerabilities.kevListedAt),
            })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.findingIdentity, identity));
        return { publishedAt: row?.publishedAt ?? null, kevListedAt: row?.kevListedAt ?? null };
    },

    /** `clusters.first_inventory_at` per cluster; null = never recorded, which proves nothing. */
    async observationStarts(orgId: string, clusterIds: string[]): Promise<Map<string, Date | null>> {
        if (clusterIds.length === 0) return new Map();
        const rows = await db
            .select({ id: schema.clusters.id, firstInventoryAt: schema.clusters.firstInventoryAt })
            .from(schema.clusters)
            .where(and(eq(schema.clusters.orgId, orgId), inArray(schema.clusters.id, clusterIds)));
        return new Map(rows.map((row) => [row.id, row.firstInventoryAt]));
    },

    /** Disclosure and KEV-listing dates by advisory id, for rows that only carry the id. Null and absent both mean unknown. */
    async advisoryDatesByVulnId(vulnIds: string[]): Promise<Map<string, { publishedAt: Date | null; kevListedAt: Date | null }>> {
        if (vulnIds.length === 0) return new Map();
        const rows = await db
            .select({
                vulnId: schema.vulnerabilities.vulnId,
                publishedAt: schema.vulnerabilities.publishedAt,
                kevListedAt: schema.vulnerabilities.kevListedAt,
            })
            .from(schema.vulnerabilities)
            .where(inArray(schema.vulnerabilities.vulnId, [...new Set(vulnIds)]));
        return new Map(rows.map((row) => [row.vulnId, { publishedAt: row.publishedAt, kevListedAt: row.kevListedAt }]));
    },

    /**
     * When the matcher first recorded this identity on an image the org
     * runs: `min(component_vulnerabilities.created_at)`. Display-only — a
     * `?replace=true` re-upload resets it, which is why no exposure figure
     * anchors on it.
     */
    async detectedAt(orgId: string, identity: string): Promise<Date | null> {
        const [row] = await db
            .select({ detectedAt: min(schema.componentVulnerabilities.createdAt) })
            .from(schema.componentVulnerabilities)
            .innerJoin(schema.components, eq(schema.componentVulnerabilities.componentId, schema.components.id))
            .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
            .innerJoin(schema.images, eq(schema.sboms.imageId, schema.images.id))
            .innerJoin(schema.vulnerabilities, eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id))
            .where(and(isCountedFinding(), deployedImages(orgId), sql`${findingIdentity} = ${identity}`));
        return row?.detectedAt ?? null;
    },
};

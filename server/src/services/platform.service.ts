/**
 * The StackRadar-owned platform org and cluster — the shape
 * [ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md)
 * named as the only one compatible with sharing: candidate SBOMs become
 * ordinary `images` / `sboms` / `components` / `component_vulnerabilities`
 * rows under a cluster no tenant can touch, so trusting them is trusting no
 * tenant. The entire matching pipeline, risk column and finding definitions
 * are reused byte for byte; nothing grows a parallel table.
 *
 * What keeps the boundary a boundary, all enforced in code:
 * - no member can join a system org (`organization.repository.addOrgMember`);
 * - no API key can be minted for a system org or cluster
 *   (`cluster.repository.createWithApiKey` / `rotateApiKey`), so nothing
 *   outside this process can ever upload into the platform cluster — the
 *   `platform_scan` job ingests through the SBOM service in-process, not
 *   through `/v1`;
 * - tenant counting predicates (`db/findings.ts`) scope by the tenant's own
 *   `orgId`, so platform rows never inflate a tenant's numbers by
 *   construction.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("platform");

export const PLATFORM_ORG_SLUG = "stackradar-platform";
export const PLATFORM_ORG_NAME = "StackRadar Platform";
export const PLATFORM_CLUSTER_NAME = "platform-scanner";

export interface PlatformIds {
    orgId: string;
    clusterId: string;
}

/**
 * The platform org and cluster, when they exist — the **read-path** lookup.
 * Null until the first worker run seeds them; a read path must never create
 * rows, so `recommendForRelease` uses this and simply finds no platform
 * candidates on a fresh database.
 */
export async function findPlatform(): Promise<PlatformIds | null> {
    const [org] = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(and(eq(schema.organizations.slug, PLATFORM_ORG_SLUG), eq(schema.organizations.system, true)));
    if (!org) return null;
    const [cluster] = await db
        .select({ id: schema.clusters.id })
        .from(schema.clusters)
        .where(and(eq(schema.clusters.orgId, org.id), eq(schema.clusters.name, PLATFORM_CLUSTER_NAME)));
    if (!cluster) return null;
    return { orgId: org.id, clusterId: cluster.id };
}

/**
 * Find-or-create the platform org and cluster. Idempotent and safe to race:
 * both inserts fall back to a re-select on unique violation. Called lazily by
 * the workers that need it rather than seeded by migration, so tests (which
 * wipe tables between cases) and fresh databases behave identically.
 */
export async function ensurePlatform(): Promise<PlatformIds> {
    let [org] = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(and(eq(schema.organizations.slug, PLATFORM_ORG_SLUG), eq(schema.organizations.system, true)));

    if (!org) {
        try {
            [org] = await db
                .insert(schema.organizations)
                .values({ name: PLATFORM_ORG_NAME, slug: PLATFORM_ORG_SLUG, system: true })
                .returning({ id: schema.organizations.id });
            log.info({ orgId: org!.id }, "Seeded platform organization");
        } catch {
            [org] = await db
                .select({ id: schema.organizations.id })
                .from(schema.organizations)
                .where(and(eq(schema.organizations.slug, PLATFORM_ORG_SLUG), eq(schema.organizations.system, true)));
        }
    }
    if (!org) throw new Error("Failed to seed the platform organization");

    let [cluster] = await db
        .select({ id: schema.clusters.id })
        .from(schema.clusters)
        .where(and(eq(schema.clusters.orgId, org.id), eq(schema.clusters.name, PLATFORM_CLUSTER_NAME)));

    if (!cluster) {
        try {
            // A direct insert, never `createWithApiKey`: the platform cluster
            // must not have a key, and the repository guard would refuse anyway.
            [cluster] = await db
                .insert(schema.clusters)
                .values({
                    orgId: org.id,
                    name: PLATFORM_CLUSTER_NAME,
                    description: "Platform-operated scanner for candidate chart images",
                    system: true,
                })
                .returning({ id: schema.clusters.id });
            log.info({ clusterId: cluster!.id }, "Seeded platform cluster");
        } catch {
            [cluster] = await db
                .select({ id: schema.clusters.id })
                .from(schema.clusters)
                .where(and(eq(schema.clusters.orgId, org.id), eq(schema.clusters.name, PLATFORM_CLUSTER_NAME)));
        }
    }
    if (!cluster) throw new Error("Failed to seed the platform cluster");

    return { orgId: org.id, clusterId: cluster.id };
}

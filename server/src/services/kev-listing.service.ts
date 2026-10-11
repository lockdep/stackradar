import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { countedFindingRows } from "../db/findings.js";
import { isTenantOrg } from "../db/tenant-orgs.js";
import { imageRepository } from "../repositories/image.repository.js";
import { createLogger } from "../lib/logger.js";
import type { NewActivityEvent } from "../db/schema/remediation.js";

const log = createLogger("kev-listing");

/**
 * More newly-listed advisories than this in one run is not a day's news
 * from CISA (they add a handful) — it is the first run after a long gap, or
 * a join that broke. Either way the fan-out would be a blast, not an alert.
 */
export const MAX_LISTINGS_PER_RUN = 200;
/** Images named in one event's payload; the count is exact regardless. */
const IMAGES_IN_PAYLOAD = 25;
const CONTAINERS_IN_PAYLOAD = 10;

export interface NewlyListedAdvisory {
    id: string;
    vulnId: string;
}

export interface KevListingStats {
    listed: number;
    /** Advisories that were a finding on at least one running tenant image. */
    running: number;
    events: number;
    orgs: number;
    skipped?: "first-run" | "too-many";
}

/**
 * `finding.kev-listed` — the event the KEV sync writes when CISA lists an
 * advisory that is already a finding on an image someone is running.
 *
 * The scan bracket cannot see this: a listing changes a column on
 * `vulnerabilities`, not the finding set, so `diffFindings` reports nothing
 * and the image is not rescanned (no advisory changed in the mirror). Yet
 * "something you are running is now known to be exploited" is the single
 * most important thing the product can say, so the sync says it here, once
 * per (org, advisory), with the running images in the payload.
 *
 * Findings come from `countedFindingRows` — the one definition — scoped to
 * running images and to the newly-listed advisories, so an advisory that
 * matched only `unconfirmed` is not alerted on. The scope predicate narrows
 * *which advisories* are looked at, never what counts.
 *
 * `previous` is the sync state before this run: a first run lists the whole
 * catalogue and is inventory, not change.
 */
export async function recordKevListings(
    listed: NewlyListedAdvisory[],
    previous: { lastSyncedAt: Date | null } | undefined,
    now: Date = new Date(),
): Promise<KevListingStats> {
    const stats: KevListingStats = { listed: listed.length, running: 0, events: 0, orgs: 0 };
    if (listed.length === 0) return stats;
    if (!previous?.lastSyncedAt) {
        log.info({ listed: listed.length }, "First KEV run — listings are inventory, no events");
        return { ...stats, skipped: "first-run" };
    }
    if (listed.length > MAX_LISTINGS_PER_RUN) {
        log.warn(
            { listed: listed.length, max: MAX_LISTINGS_PER_RUN },
            "Too many new KEV listings in one run — not fanning out",
        );
        return { ...stats, skipped: "too-many" };
    }

    const ids = listed.map((l) => l.id);
    const running = exists(
        db
            .select({ one: sql`1` })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.imageId, schema.images.id)),
    );
    const counted = countedFindingRows(and(running, inArray(schema.componentVulnerabilities.vulnerabilityId, ids))!);
    const rows = await db
        .select({
            orgId: schema.images.orgId,
            imageId: counted.imageId,
            clusterId: schema.images.clusterId,
            repository: schema.images.repository,
            digest: schema.images.digest,
            vulnerabilityId: counted.vulnerabilityId,
            vulnId: counted.vulnId,
            identity: counted.identity,
            packageName: counted.packageName,
            packageVersion: counted.packageVersion,
            fixedVersion: counted.fixedVersion,
            severityLevel: counted.severityLevel,
            riskScore: counted.riskScore,
            kevListedAt: counted.kevListedAt,
            kevDueDate: counted.kevDueDate,
        })
        .from(counted)
        .innerJoin(schema.images, eq(schema.images.id, counted.imageId))
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.images.orgId))
        .where(and(isTenantOrg(), sql`${schema.organizations.deletedAt} IS NULL`));

    if (rows.length === 0) return stats;

    // One event per (org, advisory identity). The identity, not the vuln id:
    // the CVE record and its distro tracker record are one finding.
    type Group = {
        orgId: string;
        identity: string;
        vulnIds: Set<string>;
        severityLevel: string | null;
        riskScore: number;
        kevListedAt: Date | null;
        kevDueDate: Date | null;
        packages: Set<string>;
        fixedVersion: string | null;
        images: Map<string, { imageId: string; clusterId: string; repository: string | null; digest: string }>;
    };
    const groups = new Map<string, Group>();
    for (const r of rows) {
        const key = `${r.orgId}|${r.identity}`;
        let g = groups.get(key);
        if (!g) {
            g = {
                orgId: r.orgId,
                identity: r.identity,
                vulnIds: new Set(),
                severityLevel: null,
                riskScore: 0,
                kevListedAt: null,
                kevDueDate: null,
                packages: new Set(),
                fixedVersion: null,
                images: new Map(),
            };
            groups.set(key, g);
        }
        g.vulnIds.add(r.vulnId);
        if ((r.riskScore ?? 0) >= g.riskScore) {
            g.riskScore = r.riskScore ?? 0;
            g.severityLevel = r.severityLevel ?? g.severityLevel;
        }
        g.kevListedAt ??= r.kevListedAt;
        g.kevDueDate ??= r.kevDueDate;
        g.packages.add(r.packageVersion ? `${r.packageName}@${r.packageVersion}` : r.packageName);
        g.fixedVersion ??= r.fixedVersion;
        g.images.set(r.imageId, {
            imageId: r.imageId,
            clusterId: r.clusterId,
            repository: r.repository,
            digest: r.digest,
        });
    }

    // Where each image runs — the alert names workloads, not digests.
    const imageIds = [...new Set(rows.map((r) => r.imageId))];
    const deployments = new Map<string, Awaited<ReturnType<typeof imageRepository.findDeployments>>>();
    for (const g of groups.values()) {
        for (const img of g.images.values()) {
            if (deployments.has(img.imageId)) continue;
            deployments.set(img.imageId, await imageRepository.findDeployments(img.imageId, g.orgId));
        }
    }

    const events: NewActivityEvent[] = [...groups.values()].map((g) => {
        // Prefer the CVE spelling for the headline; the vulnerability page resolves any of them.
        const vulnIds = [...g.vulnIds];
        const vulnId = vulnIds.find((v) => /^CVE-\d{4}-\d+$/i.test(v)) ?? vulnIds[0]!;
        const images = [...g.images.values()].map((img) => {
            const running = deployments.get(img.imageId) ?? [];
            return {
                ...img,
                containerCount: running.length,
                containers: running.slice(0, CONTAINERS_IN_PAYLOAD).map((d) => ({
                    namespace: d.namespaceName,
                    workloadKind: d.workloadKind,
                    workloadName: d.workloadName,
                    containerName: d.containerName,
                    init: d.init,
                })),
            };
        });
        images.sort((a, b) => b.containerCount - a.containerCount);
        return {
            orgId: g.orgId,
            clusterId: null,
            type: "finding.kev-listed",
            imageId: null,
            createdAt: now,
            payload: {
                vulnId,
                vulnIds,
                identity: g.identity,
                severityLevel: g.severityLevel,
                riskScore: g.riskScore,
                kevListedAt: g.kevListedAt?.toISOString() ?? null,
                kevDueDate: g.kevDueDate?.toISOString() ?? null,
                packages: [...g.packages].slice(0, 10),
                fixedVersion: g.fixedVersion,
                imageCount: images.length,
                images: images.slice(0, IMAGES_IN_PAYLOAD),
            },
        };
    });

    await db.insert(schema.activityEvents).values(events);

    stats.running = new Set(rows.map((r) => r.identity)).size;
    stats.events = events.length;
    stats.orgs = new Set(events.map((e) => e.orgId)).size;
    log.info({ ...stats, images: imageIds.length }, "Recorded KEV listings on running images");
    return stats;
}

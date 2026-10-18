import { count, countDistinct, sql, isNull, desc, asc, eq, and, or, ilike, inArray, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isCurrentGeneration } from "../db/generation.js";
import { severityRowsByImage } from "../db/findings.js";
import { scannedImageIds } from "./image.repository.js";
import { IMAGE_GC_RETENTION_DAYS, imageGcRetentionDays } from "../config/image-gc.js";
import { getPlanLimits } from "../config/plans.js";
import { edition } from "../edition.js";
import type { JobStatus } from "../db/schema/jobs.js";

import {
    isActiveAdvisory,
    isWithdrawnAdvisory,
    isActiveAffectedPackage,
    isUnscoredAdvisory,
    EMPTY_SEVERITY,
    addSeverity,
    componentCountsBySbom,
    IMAGE_STATE_FILTERS,
    type SeverityCounts,
    type AdminImageState,
} from "./admin-helpers.js";
export interface AdminEcosystemEntry {
    ecosystem: string;
    count: number;
}

/**
 * The caps an org's usage is drawn against, resolved on the server by
 * `getPlanLimits` so the admin table reads the same rule every other limit
 * check does — the community edition's one plan whatever the column says, free
 * for an unknown value on the cloud. `null` is "no cap": JSON cannot carry
 * `Infinity`, and the client would otherwise have to keep a mirror of
 * `config/plans.ts` that no gate compares.
 */
export interface AdminOrgLimits {
    members: number | null;
    clusters: number | null;
    /** Always `null` — completeness of the current picture is never charged for. */
    sboms: null;
}

export interface AdminOrganization {
    id: string;
    name: string;
    slug: string;
    plan: string;
    demo: boolean;
    createdAt: Date;
    memberCount: number;
    sbomCount: number;
    clusterCount: number;
    limits: AdminOrgLimits;
}

function finiteOrNull(n: number): number | null {
    return Number.isFinite(n) ? n : null;
}

export function adminOrgLimits(plan: string): AdminOrgLimits {
    const limits = getPlanLimits(plan);
    return { members: finiteOrNull(limits.members), clusters: finiteOrNull(limits.clusters), sboms: null };
}

/**
 * The retention figure the Images tab prints. On the cloud it is the floor
 * every plan's window is at least (`IMAGE_GC_RETENTION_DAYS`), because the
 * table mixes orgs on different plans and each row's own countdown already
 * accounts for its plan. In the community edition there is one plan, so the
 * figure can be the actual window — the one number a self-hosting admin wants
 * to know, with no plan to mention.
 */
const ADMIN_IMAGE_RETENTION_DAYS = edition.billing ? IMAGE_GC_RETENTION_DAYS : imageGcRetentionDays("community");

export interface AdminWithdrawnStats {
    /** Advisories in the mirror that OSV has since retracted. */
    advisories: number;
    /**
     * Customer findings that still point at a retracted advisory.
     *
     * The matcher refuses to create these — `matching/store.ts` filters
     * `withdrawn = false` out of the candidate query and `matching/match.ts`
     * drops withdrawn candidates again — but nothing retracts a match made
     * *before* the withdrawal. `bulkLinkComponentVulnerabilities` is insert +
     * onConflictDoUpdate only, and the sole DELETE against
     * `component_vulnerabilities` is component-cascade cleanup. So a non-zero
     * value here is not history: it is a finding being shown to a customer right
     * now for an advisory that no longer exists.
     *
     * `components` and `advisories` give the blast radius — how many customer
     * components are affected, and how few (or many) retractions caused it.
     */
    staleFindings: {
        links: number;
        components: number;
        advisories: number;
    };
    /**
     * Affected-package rows whose denormalised `withdrawn` flag still reads false
     * while the advisory itself is withdrawn.
     *
     * The schema comment on `vulnerability_affected_packages.withdrawn` asserts
     * both sync paths derive the flag from the OSV record at extract time, so the
     * two can never disagree. Nothing verified that assertion until this number.
     * Non-zero means `vuln_affected_pkg_match_key_idx` — partial on
     * `withdrawn = false` — is still serving the matcher candidates it was built
     * to exclude. A permanent zero is the cheapest proof the invariant holds.
     */
    denormalizationDrift: number;
}

/**
 * One row of the `images` table, with everything reachable from a digest.
 *
 * Deliberately not scoped to a tenant — this is the platform operator's view
 * across every org. Since ADR 0006 an image belongs to one cluster and one
 * org, so there is no org count to show: `images.org_id` is the answer, and a
 * second one would only ever be 1. `clusterCount` survives as a column because
 * a value other than 1 on a row with containers would be the symptom of a
 * broken invariant. This shape must never leak past `requireAdmin`: "which
 * tenant runs what" is provenance and belongs to them.
 */
export interface AdminImage {
    id: string;
    digest: string;
    registry: string | null;
    repository: string | null;
    firstSeenAt: Date;
    /** What the GC ages on. Bumped by any inventory report or upload naming the digest. */
    lastSeenAt: Date;
    sbomId: string | null;
    sbomFormat: string | null;
    sbomCreatedAt: Date | null;
    componentCount: number;
    /**
     * `null` means nobody has matched this image yet — never conflate with zero.
     * Same rule as the customer-facing image list, via `scannedImageIds`.
     */
    findings: SeverityCounts | null;
    /** `workload_containers` rows pointing here. */
    containerCount: number;
    /** Distinct clusters running it — 1 under ADR 0006 unless an invariant broke. */
    clusterCount: number;
    state: AdminImageState;
    /**
     * Days until the GC's cutoff reaches this image; zero or negative once it is
     * already past. `null` unless the image is orphaned, because for anything
     * still referenced the countdown does not apply — reachability is re-checked
     * under a lock at collection time.
     *
     * Computed against the owning org's *plan* window (`imageGcRetentionDays`),
     * not a global constant — the archive window is a plan axis, so two
     * orphaned images the same age can legitimately show different countdowns.
     *
     * Rounded **up**, so `n` means "gone within n days" and only a genuinely
     * expired image reports zero. Rounding down would put every image in its
     * final 24 hours at zero, and the UI renders zero as "Due" — a day of images
     * claiming to be collectable before they are.
     */
    gcInDays: number | null;
}

export type AdminImageSort = "lastSeen" | "firstSeen" | "repository";

export interface AdminImagesPage {
    images: AdminImage[];
    /** Matching the filters, before the page window — the pager needs it. */
    total: number;
    limit: number;
    offset: number;
    /**
     * The unfiltered state breakdown, so switching filters never changes the
     * counts in the filter control itself.
     */
    stateTotals: Record<AdminImageState, number>;
    /**
     * Echoed so the countdown column can explain itself without a second call.
     * The GC *floor* (free/default window) — paid orgs keep images for their
     * plan's `historyDays` instead, which `gcInDays` already accounts for.
     */
    retentionDays: number;
}

export const adminRepository = {
    async getRecentOrganizations(limit = 10): Promise<AdminOrganization[]> {
        const rows = await db
            .select({
                id: schema.organizations.id,
                name: schema.organizations.name,
                slug: schema.organizations.slug,
                plan: schema.organizations.plan,
                // Stays in the list — an admin should see it — but badged by the
                // client so its `team` plan with no Stripe customer is not mistaken
                // for a paying account.
                demo: schema.organizations.demo,
                createdAt: schema.organizations.createdAt,
                memberCount: sql<number>`(
          select count(*) from ${schema.orgMembers}
          where ${schema.orgMembers.orgId} = ${schema.organizations.id}
        )`.as("member_count"),
                sbomCount: sql<number>`(
          select count(distinct s.id) from sboms s
          join workload_containers wc on wc.image_id = s.image_id
          where wc.org_id = organizations.id
        )`.as("sbom_count"),
                clusterCount: sql<number>`(
          select count(*) from clusters c
          where c.org_id = organizations.id
        )`.as("cluster_count"),
            })
            .from(schema.organizations)
            // Not the platform org (`platform.service.ts`): nobody can join it,
            // nothing can be minted for it, and its plan is not a sale — it is
            // the StackRadar-owned cluster the chart index scans into, and on
            // an admin screen it would read as a tenant with no members.
            .where(and(isNull(schema.organizations.deletedAt), eq(schema.organizations.system, false)))
            .orderBy(desc(schema.organizations.createdAt))
            .limit(limit);

        return rows.map((row) => ({ ...row, limits: adminOrgLimits(row.plan) }));
    },

    async getVulnerabilityStats() {
        const [totalRow, withdrawnRow, unscoredRow, severityRows, affectedPkgRow] = await Promise.all([
            db.select({ total: count() }).from(schema.vulnerabilities).where(isActiveAdvisory()),
            db.select({ total: count() }).from(schema.vulnerabilities).where(isWithdrawnAdvisory()),
            db.select({ total: count() }).from(schema.vulnerabilities).where(isUnscoredAdvisory()),
            db
                .select({ level: schema.vulnerabilities.severityLevel, total: count() })
                .from(schema.vulnerabilities)
                .where(isActiveAdvisory())
                .groupBy(schema.vulnerabilities.severityLevel),
            db.select({ total: count() }).from(schema.vulnerabilityAffectedPackages).where(isActiveAffectedPackage()),
        ]);

        const bySeverity: Record<string, number> = {};
        for (const row of severityRows) {
            bySeverity[row.level ?? "unknown"] = Number(row.total);
        }

        return {
            total: Number(totalRow[0]?.total ?? 0),
            withdrawn: Number(withdrawnRow[0]?.total ?? 0),
            bySeverity,
            withoutCvssScore: Number(unscoredRow[0]?.total ?? 0),
            affectedPackagesTotal: Number(affectedPkgRow[0]?.total ?? 0),
        };
    },

    /**
     * The three numbers `vulnerabilities.withdrawn_at` is actually worth
     * rendering. A raw count of retracted advisories is trivia; what matters is
     * whether the retraction reached the customer's findings (`staleFindings`)
     * and whether the denormalised copy of the flag agrees with it
     * (`denormalizationDrift`). See AdminWithdrawnStats for why each is here.
     */
    async getWithdrawnStats(): Promise<AdminWithdrawnStats> {
        const [advisoryRow, staleRow, driftRow] = await Promise.all([
            db.select({ total: count() }).from(schema.vulnerabilities).where(isWithdrawnAdvisory()),

            db
                .select({
                    links: count(),
                    components: countDistinct(schema.componentVulnerabilities.componentId),
                    advisories: countDistinct(schema.componentVulnerabilities.vulnerabilityId),
                })
                .from(schema.componentVulnerabilities)
                .innerJoin(
                    schema.vulnerabilities,
                    eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id),
                )
                .where(isWithdrawnAdvisory()),

            // Only the false-negative direction (advisory withdrawn, flag still
            // false) is checked. That is the one that costs something: it leaves rows
            // inside the matcher's partial index. The reverse — flag true, advisory
            // live — would need a scan of every `withdrawn = true` row, which no index
            // covers precisely because those rows are excluded from the one that
            // matters, and it fails safe anyway (a candidate withheld, not served).
            db
                .select({ total: count() })
                .from(schema.vulnerabilityAffectedPackages)
                .innerJoin(
                    schema.vulnerabilities,
                    eq(schema.vulnerabilityAffectedPackages.vulnerabilityId, schema.vulnerabilities.id),
                )
                .where(
                    and(
                        isWithdrawnAdvisory(),
                        eq(schema.vulnerabilityAffectedPackages.withdrawn, false),
                        isCurrentGeneration(),
                    ),
                ),
        ]);

        return {
            advisories: Number(advisoryRow[0]?.total ?? 0),
            staleFindings: {
                links: Number(staleRow[0]?.links ?? 0),
                components: Number(staleRow[0]?.components ?? 0),
                advisories: Number(staleRow[0]?.advisories ?? 0),
            },
            denormalizationDrift: Number(driftRow[0]?.total ?? 0),
        };
    },

    async getAdvisoryIdDistribution(limit = 20): Promise<AdminEcosystemEntry[]> {
        const rows = await db
            .select({
                ecosystem: schema.vulnerabilities.idPrefix,
                total: count(),
            })
            .from(schema.vulnerabilities)
            .where(isActiveAdvisory())
            .groupBy(schema.vulnerabilities.idPrefix)
            .orderBy(desc(count()))
            .limit(limit);

        return rows.map((r) => ({
            ecosystem: r.ecosystem || "unknown",
            count: Number(r.total),
        }));
    },

    async getEcosystemDistribution(limit = 15): Promise<AdminEcosystemEntry[]> {
        const normalizedEcosystem = sql<string>`SPLIT_PART(${schema.vulnerabilityAffectedPackages.ecosystem}, ':', 1)`;
        const rows = await db
            .select({
                ecosystem: normalizedEcosystem.as("ecosystem"),
                total: count(),
            })
            .from(schema.vulnerabilityAffectedPackages)
            .where(isActiveAffectedPackage())
            .groupBy(normalizedEcosystem)
            .orderBy(desc(count()))
            .limit(limit);

        return rows.map((r) => ({
            ecosystem: r.ecosystem || "unknown",
            count: Number(r.total),
        }));
    },

    async getAdminJobs(options?: { status?: string[]; limit?: number; offset?: number }) {
        const limit = options?.limit ?? 50;
        const offset = options?.offset ?? 0;

        // One predicate, both queries. `total` drives the client's page count, so a
        // count that ignores the status filter reports pages of rows the filtered
        // query will never return — "Page 1 of 100" over three failed jobs.
        const statusFilter = options?.status?.length
            ? inArray(schema.jobs.status, options.status as JobStatus[])
            : undefined;

        let query = db
            .select({
                id: schema.jobs.id,
                orgId: schema.jobs.orgId,
                orgName: schema.organizations.name,
                orgSlug: schema.organizations.slug,
                imageId: schema.jobs.imageId,
                type: schema.jobs.type,
                status: schema.jobs.status,
                priority: schema.jobs.priority,
                title: schema.jobs.title,
                triggeredBy: schema.jobs.triggeredBy,
                scheduledFor: schema.jobs.scheduledFor,
                startedAt: schema.jobs.startedAt,
                completedAt: schema.jobs.completedAt,
                progress: schema.jobs.progress,
                progressMessage: schema.jobs.progressMessage,
                errorCode: schema.jobs.errorCode,
                errorMessage: schema.jobs.errorMessage,
                retryCount: schema.jobs.retryCount,
                maxRetries: schema.jobs.maxRetries,
                createdAt: schema.jobs.createdAt,
            })
            .from(schema.jobs)
            .innerJoin(schema.organizations, eq(schema.jobs.orgId, schema.organizations.id))
            .$dynamic();

        if (statusFilter) {
            query = query.where(statusFilter);
        }

        // The count omits the organizations join the row query carries: `jobs.org_id`
        // is NOT NULL with an FK, so the inner join never drops a row, and the join
        // would only cost the count a scan it does not need.
        let countQuery = db.select({ total: count() }).from(schema.jobs).$dynamic();
        if (statusFilter) {
            countQuery = countQuery.where(statusFilter);
        }

        const [rows, totalRow] = await Promise.all([
            query.orderBy(desc(schema.jobs.createdAt)).limit(limit).offset(offset),
            countQuery,
        ]);

        return {
            jobs: rows,
            total: Number(totalRow[0]?.total ?? 0),
            limit,
            offset,
        };
    },

    // ── Images ─────────────────────────────────────────────────────────────────

    /**
     * Every image in the database, whoever runs it and whether or not it has been
     * scanned.
     *
     * The Explorer's image list answers a different question and cannot answer
     * this one: it starts `FROM sboms` and filters by `deployedImages(orgId)`, so
     * an image is invisible there unless it has an SBOM *and* a container in the
     * selected org. That hides exactly the rows an operator needs — the ingest
     * backlog (discovered, unscanned) and the GC's queue (referenced by nothing).
     * This starts `FROM images` and left-joins everything else, so those rows
     * survive.
     *
     * Counts come from grouped queries keyed on the page's ids rather than
     * correlated subqueries: a correlated subquery over `images` renders the
     * outer column unqualified and silently matches the inner table instead.
     */
    async listAdminImages(options: {
        limit: number;
        offset: number;
        state?: AdminImageState;
        search?: string;
        sort?: AdminImageSort;
    }): Promise<AdminImagesPage> {
        const limit = Math.min(Math.max(options.limit, 1), 200);
        const offset = Math.max(options.offset, 0);

        const filters: SQL[] = [];
        if (options.state) filters.push(IMAGE_STATE_FILTERS[options.state]);
        if (options.search) {
            const term = `%${options.search}%`;
            filters.push(
                or(
                    ilike(schema.images.digest, term),
                    ilike(schema.images.repository, term),
                    ilike(schema.images.registry, term),
                )!,
            );
        }
        const where = filters.length > 0 ? and(...filters) : undefined;

        const orderBy = {
            lastSeen: [desc(schema.images.lastSeenAt)],
            firstSeen: [desc(schema.images.firstSeenAt)],
            // Digest as the tie-break: repository is nullable and far from unique, and
            // an unstable order across pages shows rows twice and skips others.
            repository: [asc(schema.images.repository), asc(schema.images.digest)],
        }[options.sort ?? "lastSeen"];

        const [rows, [totalRow], orphanedTotal, awaitingTotal, scannedTotal] = await Promise.all([
            db
                .select({
                    id: schema.images.id,
                    digest: schema.images.digest,
                    registry: schema.images.registry,
                    repository: schema.images.repository,
                    firstSeenAt: schema.images.firstSeenAt,
                    lastSeenAt: schema.images.lastSeenAt,
                    // For the GC countdown: the window depends on the owning org's plan.
                    plan: schema.organizations.plan,
                })
                .from(schema.images)
                .innerJoin(schema.organizations, eq(schema.images.orgId, schema.organizations.id))
                .where(where)
                .orderBy(...orderBy)
                .limit(limit)
                .offset(offset),
            db.select({ total: count() }).from(schema.images).where(where),
            // Unfiltered on purpose: these label the filter control, so they must not
            // change when the filter does.
            db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.orphaned),
            db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.awaiting_sbom),
            db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.scanned),
        ]);

        const stateTotals: Record<AdminImageState, number> = {
            orphaned: Number(orphanedTotal[0]?.total ?? 0),
            awaiting_sbom: Number(awaitingTotal[0]?.total ?? 0),
            scanned: Number(scannedTotal[0]?.total ?? 0),
        };

        const page: AdminImagesPage = {
            images: [],
            total: Number(totalRow?.total ?? 0),
            limit,
            offset,
            stateTotals,
            retentionDays: ADMIN_IMAGE_RETENTION_DAYS,
        };
        if (rows.length === 0) return page;

        const imageIds = rows.map((r) => r.id);

        const [sbomRows, usageRows, findingRows] = await Promise.all([
            db
                .select({
                    id: schema.sboms.id,
                    imageId: schema.sboms.imageId,
                    format: schema.sboms.format,
                    createdAt: schema.sboms.createdAt,
                })
                .from(schema.sboms)
                .where(inArray(schema.sboms.imageId, imageIds)),

            // One pass for all three usage figures. The joins up to `namespaces` do
            // not change `count(*)` — `workload_id` and `namespace_id` are both
            // `notNull` FKs, so a container has exactly one workload and a workload
            // exactly one namespace — which is also what lets `state` below be
            // derived from `containerCount` and still agree with the SQL predicate
            // the filter uses. Make either column nullable and the two drift.
            db
                .select({
                    imageId: schema.workloadContainers.imageId,
                    containerCount: count(),
                    clusterCount: countDistinct(schema.namespaces.clusterId),
                })
                .from(schema.workloadContainers)
                .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
                .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
                .where(inArray(schema.workloadContainers.imageId, imageIds))
                .groupBy(schema.workloadContainers.imageId),

            // `severityRowsByImage` (over `collapsedFindings`) and nothing else —
            // this column has to agree with the number the customer sees for the
            // same digest, so the three rules in `db/findings.ts` apply here exactly
            // as they do everywhere. Only the bucketing differs: the local
            // `addSeverity` keeps an `unknown` bucket that the customer-facing
            // surfaces fold away, and on an admin screen "we could not rank 40 of
            // these" is the finding.
            severityRowsByImage(imageIds),
        ]);

        const sbomByImage = new Map(sbomRows.map((r) => [r.imageId, r]));
        const usageByImage = new Map(usageRows.map((r) => [r.imageId, r]));

        const findingsByImage = new Map<string, SeverityCounts>();
        for (const row of findingRows) {
            let counts = findingsByImage.get(row.imageId);
            if (!counts) {
                counts = EMPTY_SEVERITY();
                findingsByImage.set(row.imageId, counts);
            }
            addSeverity(counts, row.severityLevel, Number(row.count));
        }

        const [componentCounts, scanned] = await Promise.all([
            componentCountsBySbom(sbomRows.map((r) => r.id)),
            scannedImageIds(new Map(sbomRows.map((r) => [r.imageId, r.id]))),
        ]);

        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1_000;

        page.images = rows.map((r) => {
            const sbom = sbomByImage.get(r.id);
            const usage = usageByImage.get(r.id);
            const containerCount = Number(usage?.containerCount ?? 0);
            const state: AdminImageState = containerCount === 0 ? "orphaned" : sbom ? "scanned" : "awaiting_sbom";

            return {
                id: r.id,
                digest: r.digest,
                registry: r.registry,
                repository: r.repository,
                firstSeenAt: r.firstSeenAt,
                lastSeenAt: r.lastSeenAt,
                sbomId: sbom?.id ?? null,
                sbomFormat: sbom?.format ?? null,
                sbomCreatedAt: sbom?.createdAt ?? null,
                componentCount: sbom ? (componentCounts.get(sbom.id) ?? 0) : 0,
                findings: scanned.has(r.id) ? (findingsByImage.get(r.id) ?? EMPTY_SEVERITY()) : null,
                containerCount,
                clusterCount: Number(usage?.clusterCount ?? 0),
                state,
                gcInDays:
                    state === "orphaned"
                        ? Math.ceil(imageGcRetentionDays(r.plan) - (now - r.lastSeenAt.getTime()) / DAY_MS)
                        : null,
            };
        });

        return page;
    },

    // ── SBOM Explorer ──────────────────────────────────────────────────────────
};

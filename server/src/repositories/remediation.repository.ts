/**
 * Data access for the remediation workflow: the fix rollup's raw counts, the
 * issue lifecycle, suppressions and the activity log.
 *
 * The rollup queries here go through `collapsedFindings` — the single
 * definition of a finding — and add no counting rules of their own. What they
 * add is the *suppression* join: a `finding_states` row that has not expired
 * moves a finding out of its bucket and into `suppressed`. That exclusion is
 * deliberately scoped to the Fix surface for now; widening it to every
 * counting surface (dashboard, trends) is a product decision the proposal
 * leaves open, not something to drift into from a repository.
 */

import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import { collapsedFindings, countedFindingRows, deployedImages, findingIdentity } from "../db/findings.js";
import type { LensBucket } from "../db/finding-tier.js";
import { dependencyBumpCommand } from "../lib/remediation-commands.js";
import { PLAN_LIMITS, getPlanLimits, type PlanType } from "../config/plans.js";
import type {
    ActivityEvent,
    NewActivityEvent,
    FindingState,
    NewFindingState,
    Issue,
    NewIssue,
    IssueState,
} from "../db/schema/remediation.js";

/** One aggregated cell of the phase-1 rollup, folded by the service. */
export interface RollupCell {
    imageId: string;
    fixable: boolean;
    /**
     * The finding is on a package the customer's build added (the tier lens's
     * `application` bucket, `db/finding-tier.ts`). `fixable && byYou` is
     * "fixable by you": a fixed glibc is fixable, and not by a dependency bump.
     */
    byYou: boolean;
    suppressed: boolean;
    matchedEcosystem: string | null;
    severityLevel: string | null;
    count: number;
    /**
     * Summed per-finding risk of the cell — the suggestion feed's "could
     * address up to" upper bound for unmeasured moves. Since ADR 0007 this is
     * the same arithmetic as the aggregate score itself, so "up to" is now an
     * exact ceiling rather than a deliberate overstatement.
     */
    riskSum: number;
}

/** A single finding of one image, bucketed by the service. */
export interface ImageFindingRow {
    vulnId: string;
    packageType: string;
    packageName: string;
    packageVersion: string | null;
    severityLevel: string | null;
    riskScore: number | null;
    kevListed: boolean;
    epssScore: number | null;
    fixedVersion: string | null;
    matchedEcosystem: string | null;
    /**
     * The one-line dependency bump that closes it (`npm install lodash@4.17.21`),
     * for an application finding with a fixed version in an ecosystem we can
     * spell a command for. Advice, never a button. Null otherwise.
     */
    bumpCommand: string | null;
    /** The tier lens bucket — "application" is the customer's to bump. */
    bucket: LensBucket;
    /** A fixed version is known *and* the package is in the application bucket. */
    fixableByYou: boolean;
    suppression: {
        id: string;
        kind: string;
        reason: string;
        createdByEmail: string;
        expiresAt: Date;
    } | null;
}

/** The three issue states that are neither terminal nor machine-owned. */
const IN_FLIGHT_STATES: IssueState[] = ["open", "snoozed", "applied"];

/** `${type}|${name}|${identity}` — the same shape `finding-delta.ts` keys on. */
export function findingIssueKey(issue: {
    packageType: string | null;
    packageName: string | null;
    vulnIdentity: string | null;
}): string {
    return `${issue.packageType}|${issue.packageName}|${issue.vulnIdentity}`;
}

/** What is left of a finding issue's identity in the org, per cluster. */
export interface FindingIssueStatus {
    /** Counted findings still carrying the identity, org-wide. */
    remaining: number;
    /** The worst matching advisory's own `risk_score` — layer 1 of ADR 0005. */
    maxRisk: number | null;
    /** Any matching counted finding now records a fixed version. */
    fixAvailable: boolean;
    /** Org-wide identity can surprise; the per-cluster split explains it. */
    perCluster: Array<{ clusterId: string; clusterName: string | null; count: number }>;
}

/** The suppression join, shared by both rollup shapes. */
function activeSuppression(orgId: string, f: ReturnType<typeof collapsedFindings>) {
    return and(
        eq(schema.findingStates.orgId, orgId),
        eq(schema.findingStates.packageType, f.packageType),
        eq(schema.findingStates.packageName, f.packageName),
        eq(schema.findingStates.vulnIdentity, f.identity),
        gt(schema.findingStates.expiresAt, sql`now()`)
    );
}

export const remediationRepository = {
    /**
     * The phase-1 rollup's raw material: per image, findings counted into
     * (fixable, suppressed, ecosystem, severity) cells. The service applies
     * the EOL verdict — a TypeScript judgement over vendored dates — which is
     * why the ecosystem string comes out instead of a bucket name.
     */
    async fixRollup(orgId: string): Promise<RollupCell[]> {
        const f = collapsedFindings(deployedImages(orgId));
        const fixable = sql<boolean>`${f.fixedVersion} IS NOT NULL`;
        const byYou = sql<boolean>`${f.bucket} = 'application'`;
        const suppressed = sql<boolean>`${schema.findingStates.id} IS NOT NULL`;

        const rows = await db
            .select({
                imageId: f.imageId,
                fixable: sql<boolean>`${fixable}`.as("fixable"),
                byYou: sql<boolean>`${byYou}`.as("by_you"),
                suppressed: sql<boolean>`${suppressed}`.as("suppressed"),
                matchedEcosystem: f.matchedEcosystem,
                severityLevel: f.severityLevel,
                count: sql<number>`count(*)::int`,
                riskSum: sql<number>`coalesce(sum(${f.riskScore}), 0)::float`,
            })
            .from(f)
            .leftJoin(schema.findingStates, activeSuppression(orgId, f))
            .groupBy(f.imageId, fixable, byYou, suppressed, f.matchedEcosystem, f.severityLevel);

        return rows;
    },

    /** Every finding of one image, with its live suppression if any. */
    async findingsForImage(orgId: string, imageId: string): Promise<ImageFindingRow[]> {
        const f = collapsedFindings(eq(schema.images.id, imageId));

        const rows = await db
            .select({
                vulnId: f.vulnId,
                packageType: f.packageType,
                packageName: f.packageName,
                severityLevel: f.severityLevel,
                riskScore: f.riskScore,
                kevListedAt: f.kevListedAt,
                epssScore: f.epssScore,
                fixedVersion: f.fixedVersion,
                matchedEcosystem: f.matchedEcosystem,
                bucket: f.bucket,
                purl: f.purl,
                componentId: f.componentId,
                suppressionId: schema.findingStates.id,
                suppressionKind: schema.findingStates.kind,
                suppressionReason: schema.findingStates.reason,
                suppressionByEmail: schema.findingStates.createdByEmail,
                suppressionExpiresAt: schema.findingStates.expiresAt,
            })
            .from(f)
            .leftJoin(schema.findingStates, activeSuppression(orgId, f))
            .orderBy(sql`${f.riskScore} DESC NULLS LAST`);

        const componentIds = [...new Set(rows.map((r) => r.componentId))];
        const versions =
            componentIds.length === 0
                ? []
                : await db
                      .select({ id: schema.components.id, version: schema.components.version })
                      .from(schema.components)
                      .where(inArray(schema.components.id, componentIds));
        const versionById = new Map(versions.map((v) => [v.id, v.version]));

        return rows.map((r) => ({
            vulnId: r.vulnId,
            packageType: r.packageType,
            packageName: r.packageName,
            packageVersion: versionById.get(r.componentId) ?? null,
            severityLevel: r.severityLevel,
            riskScore: r.riskScore,
            kevListed: r.kevListedAt != null,
            epssScore: r.epssScore == null ? null : Number(r.epssScore),
            fixedVersion: r.fixedVersion,
            matchedEcosystem: r.matchedEcosystem,
            bucket: r.bucket,
            bumpCommand:
                r.bucket === "application"
                    ? dependencyBumpCommand({ purl: r.purl, name: r.packageName, fixedVersion: r.fixedVersion })
                    : null,
            fixableByYou: r.fixedVersion != null && r.bucket === "application",
            suppression:
                r.suppressionId != null
                    ? {
                          id: r.suppressionId,
                          kind: r.suppressionKind!,
                          reason: r.suppressionReason!,
                          createdByEmail: r.suppressionByEmail!,
                          expiresAt: r.suppressionExpiresAt!,
                      }
                    : null,
        }));
    },

    /** Distinct workloads per image across the org — the "6 moves, not 40 rows" number. */
    /**
     * Distinct workloads and distinct images per Helm release — the spread an
     * unmeasured chart bump lands on. Counted here rather than summed from
     * per-image rows so a workload running two of the release's images is
     * one workload.
     */
    async releaseSpread(
        orgId: string
    ): Promise<Map<string, { workloads: number; containers: number; images: number }>> {
        const rows = await db
            .select({
                releaseId: schema.workloads.releaseId,
                workloads: sql<number>`count(DISTINCT ${schema.workloads.id})::int`,
                containers: sql<number>`count(DISTINCT ${schema.workloadContainers.id})::int`,
                images: sql<number>`count(DISTINCT ${schema.workloadContainers.imageId})::int`,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .where(and(eq(schema.workloadContainers.orgId, orgId), isNotNull(schema.workloads.releaseId)))
            .groupBy(schema.workloads.releaseId);
        return new Map(
            rows
                .filter((r): r is typeof r & { releaseId: string } => r.releaseId != null)
                .map((r) => [r.releaseId, { workloads: r.workloads, containers: r.containers, images: r.images }])
        );
    },

    async workloadCountsByImage(orgId: string): Promise<Map<string, number>> {
        const rows = await db
            .select({
                imageId: schema.workloadContainers.imageId,
                workloads: sql<number>`count(DISTINCT ${schema.workloadContainers.workloadId})::int`,
            })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.orgId, orgId))
            .groupBy(schema.workloadContainers.imageId);
        return new Map(rows.map((r) => [r.imageId, r.workloads]));
    },

    /**
     * The releases whose workloads run any of `imageIds`, one row per
     * (release, image) pair — the suggestion feed's release-axis fan-out set.
     * The caller folds rows into release → images; the images are how the
     * feed knows which release a finding-carrying image is packaged by.
     */
    async releasesForImages(orgId: string, imageIds: string[]) {
        if (imageIds.length === 0) return [];
        return db
            .selectDistinct({
                releaseId: schema.helmReleases.id,
                name: schema.helmReleases.name,
                namespace: schema.helmReleases.namespace,
                chartName: schema.helmReleases.chartName,
                chartVersion: schema.helmReleases.chartVersion,
                appVersion: schema.helmReleases.appVersion,
                repoUrl: schema.helmReleases.repoUrl,
                clusterId: schema.helmReleases.clusterId,
                clusterName: schema.clusters.name,
                imageId: schema.workloadContainers.imageId,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.helmReleases, eq(schema.workloads.releaseId, schema.helmReleases.id))
            .innerJoin(schema.clusters, eq(schema.helmReleases.clusterId, schema.clusters.id))
            .where(
                and(
                    eq(schema.workloadContainers.orgId, orgId),
                    inArray(schema.workloadContainers.imageId, imageIds)
                )
            );
    },

    /**
     * How each image is delivered — through a Helm release, a GitOps app,
     * both or neither. One row per distinct (image, release, application)
     * combination; the service folds. This is what decides whether a measured
     * tag move renders as a plain tag upgrade or as a values override on the
     * chart that pins the tag.
     */
    async deliveryContextForImages(orgId: string, imageIds: string[]) {
        if (imageIds.length === 0) return [];
        return db
            .selectDistinct({
                imageId: schema.workloadContainers.imageId,
                releaseId: schema.helmReleases.id,
                releaseName: schema.helmReleases.name,
                releaseNamespace: schema.helmReleases.namespace,
                releaseChartName: schema.helmReleases.chartName,
                applicationTool: schema.gitopsApplications.tool,
                applicationName: schema.gitopsApplications.name,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .leftJoin(schema.helmReleases, eq(schema.workloads.releaseId, schema.helmReleases.id))
            .leftJoin(
                schema.gitopsApplications,
                eq(schema.workloads.applicationId, schema.gitopsApplications.id)
            )
            .where(
                and(
                    eq(schema.workloadContainers.orgId, orgId),
                    inArray(schema.workloadContainers.imageId, imageIds)
                )
            );
    },

    /**
     * Everything the phase-2 command builder needs, per container running the
     * image: the workload and its kind, the namespace, and the packaging and
     * delivery rows when they exist. Wider than
     * `imageRepository.findDeployments`, which serves the image page and does
     * not join the release or application.
     */
    async findDeliveryTargets(imageId: string, orgId: string) {
        return db
            .select({
                containerId: schema.workloadContainers.id,
                containerName: schema.workloadContainers.name,
                init: schema.workloadContainers.init,
                imageRef: schema.workloadContainers.imageRef,
                imageTag: schema.workloadContainers.imageTag,
                runningPods: schema.workloadContainers.runningPods,
                workloadId: schema.workloads.id,
                workloadName: schema.workloads.name,
                workloadKind: schema.workloads.kind,
                namespaceName: schema.namespaces.name,
                clusterId: schema.namespaces.clusterId,
                release: {
                    id: schema.helmReleases.id,
                    name: schema.helmReleases.name,
                    namespace: schema.helmReleases.namespace,
                    chartName: schema.helmReleases.chartName,
                    chartVersion: schema.helmReleases.chartVersion,
                },
                application: {
                    id: schema.gitopsApplications.id,
                    tool: schema.gitopsApplications.tool,
                    name: schema.gitopsApplications.name,
                    namespace: schema.gitopsApplications.namespace,
                    repoUrl: schema.gitopsApplications.repoUrl,
                    targetRevision: schema.gitopsApplications.targetRevision,
                    chart: schema.gitopsApplications.chart,
                    path: schema.gitopsApplications.path,
                },
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .leftJoin(schema.helmReleases, eq(schema.workloads.releaseId, schema.helmReleases.id))
            .leftJoin(
                schema.gitopsApplications,
                eq(schema.workloads.applicationId, schema.gitopsApplications.id)
            )
            .where(
                and(
                    eq(schema.workloadContainers.imageId, imageId),
                    eq(schema.workloadContainers.orgId, orgId)
                )
            )
            .orderBy(schema.namespaces.name, schema.workloads.name, schema.workloadContainers.name);
    },

    // ----- issues ----------------------------------------------------------

    async createIssue(data: NewIssue, tx?: Transaction): Promise<Issue> {
        const [result] = await (tx ?? db).insert(schema.issues).values(data).returning();
        return result!;
    },

    async findIssueById(id: string, orgId: string): Promise<Issue | undefined> {
        const [result] = await db
            .select()
            .from(schema.issues)
            .where(and(eq(schema.issues.id, id), eq(schema.issues.orgId, orgId)));
        return result;
    },

    async listIssues(
        orgId: string,
        filter: { states?: IssueState[]; clusterId?: string } = {}
    ): Promise<Issue[]> {
        return db
            .select()
            .from(schema.issues)
            .where(
                and(
                    eq(schema.issues.orgId, orgId),
                    filter.states && filter.states.length > 0
                        ? inArray(schema.issues.state, filter.states)
                        : undefined,
                    // A finding issue is org-wide; it belongs to every cluster scope.
                    filter.clusterId != null
                        ? or(
                              eq(schema.issues.clusterId, filter.clusterId),
                              isNull(schema.issues.clusterId)
                          )
                        : undefined
                )
            )
            .orderBy(desc(schema.issues.createdAt));
    },

    async updateIssue(
        id: string,
        orgId: string,
        patch: Partial<
            Pick<
                Issue,
                | "state"
                | "snoozedUntil"
                | "appliedAt"
                | "verifiedAt"
                | "closedAt"
                | "closedReason"
                | "closedNote"
                | "closedByUserId"
                | "closedByEmail"
                | "notes"
            >
        >
    ): Promise<Issue | undefined> {
        const [result] = await db
            .update(schema.issues)
            .set({ ...patch, updatedAt: new Date() })
            .where(and(eq(schema.issues.id, id), eq(schema.issues.orgId, orgId)))
            .returning();
        return result;
    },

    /**
     * The inventory sweep's input: this cluster's applied image issues, each
     * with whether the digest it moves *away from* is still running here.
     * "Still running" is an EXISTS over `workload_containers` through the
     * cluster's own image row — inventory is a full set replacement, so the
     * first report after the deploy answers it.
     */
    async findAppliedImageIssues(
        clusterId: string
    ): Promise<Array<{ issue: Issue; fromDigestStillRunning: boolean }>> {
        const stillRunning = sql<boolean>`EXISTS (
            SELECT 1
            FROM ${schema.workloadContainers} wc
            JOIN ${schema.images} i ON wc.image_id = i.id
            WHERE i.cluster_id = ${schema.issues.clusterId}
              AND i.digest = ${schema.issues.fromDigest}
        )`;
        const rows = await db
            .select({
                issue: schema.issues,
                fromDigestStillRunning: stillRunning,
            })
            .from(schema.issues)
            .where(
                and(
                    eq(schema.issues.clusterId, clusterId),
                    eq(schema.issues.state, "applied"),
                    eq(schema.issues.scope, "image")
                )
            );
        return rows;
    },

    /**
     * The inventory sweep's release half: applied release issues with the
     * release's *current* chart version — moved off the recorded
     * `fromChartVersion` means the bump landed. The join is left: a deleted
     * release nulls `releaseId`, and such an issue stays `applied` rather
     * than being verified by absence.
     */
    async findAppliedReleaseIssues(
        clusterId: string
    ): Promise<Array<{ issue: Issue; currentChartVersion: string | null }>> {
        return db
            .select({
                issue: schema.issues,
                currentChartVersion: schema.helmReleases.chartVersion,
            })
            .from(schema.issues)
            .leftJoin(schema.helmReleases, eq(schema.issues.releaseId, schema.helmReleases.id))
            .where(
                and(
                    eq(schema.issues.clusterId, clusterId),
                    eq(schema.issues.state, "applied"),
                    eq(schema.issues.scope, "release")
                )
            );
    },

    /**
     * The scan sweep's input: the org's in-flight finding issues. A finding
     * issue has no cluster and no digest to watch — it verifies when no
     * counted finding with its identity remains in the org, so it is checked
     * where finding sets change, not where inventory lands.
     */
    async findInFlightFindingIssues(orgId: string): Promise<Issue[]> {
        return db
            .select()
            .from(schema.issues)
            .where(
                and(
                    eq(schema.issues.orgId, orgId),
                    eq(schema.issues.scope, "finding"),
                    inArray(schema.issues.state, IN_FLIGHT_STATES)
                )
            );
    },

    /**
     * The `fix.available` consumer's lookup: every org's in-flight finding
     * issues matching any of `identities`. Cross-org on purpose — the OSV
     * sync is tenant-blind, and each emitted event carries its issue's own
     * `orgId`. Scoped to in-flight issues only: the event table's rule is
     * changes someone cares about, not a firehose of every advisory edit.
     */
    async findInFlightFindingIssuesByIdentities(identities: string[]): Promise<Issue[]> {
        if (identities.length === 0) return [];
        return db
            .select()
            .from(schema.issues)
            .where(
                and(
                    eq(schema.issues.scope, "finding"),
                    inArray(schema.issues.state, IN_FLIGHT_STATES),
                    inArray(schema.issues.vulnIdentity, identities)
                )
            );
    },

    /**
     * What remains of each finding identity in the org, per cluster — the
     * scan sweep's verdict input and the issue detail's "still counted in
     * cluster X" explanation. Keys are `findingIssueKey` strings; an identity
     * with no counted finding left is simply absent from the map.
     */
    async findingIssueStatus(
        orgId: string,
        keys: Array<{ packageType: string; packageName: string; vulnIdentity: string }>
    ): Promise<Map<string, FindingIssueStatus>> {
        const out = new Map<string, FindingIssueStatus>();
        if (keys.length === 0) return out;

        const f = collapsedFindings(deployedImages(orgId));
        const rows = await db
            .select({
                packageType: f.packageType,
                packageName: f.packageName,
                identity: f.identity,
                clusterId: schema.images.clusterId,
                clusterName: schema.clusters.name,
                count: sql<number>`count(*)::int`,
                maxRisk: sql<number | null>`max(${f.riskScore})`,
                fixAvailable: sql<boolean>`bool_or(${f.fixedVersion} IS NOT NULL)`,
            })
            .from(f)
            .innerJoin(schema.images, eq(f.imageId, schema.images.id))
            .innerJoin(schema.clusters, eq(schema.images.clusterId, schema.clusters.id))
            .where(
                or(
                    ...keys.map((k) =>
                        and(
                            eq(f.packageType, k.packageType),
                            eq(f.packageName, k.packageName),
                            eq(f.identity, k.vulnIdentity)
                        )
                    )
                )
            )
            .groupBy(f.packageType, f.packageName, f.identity, schema.images.clusterId, schema.clusters.name);

        for (const row of rows) {
            const key = `${row.packageType}|${row.packageName}|${row.identity}`;
            const status = out.get(key) ?? {
                remaining: 0,
                maxRisk: null,
                fixAvailable: false,
                perCluster: [],
            };
            status.remaining += row.count;
            const risk = row.maxRisk == null ? null : Number(row.maxRisk);
            if (risk != null && (status.maxRisk == null || risk > status.maxRisk)) {
                status.maxRisk = risk;
            }
            status.fixAvailable = status.fixAvailable || row.fixAvailable;
            status.perCluster.push({
                clusterId: row.clusterId,
                clusterName: row.clusterName,
                count: row.count,
            });
            out.set(key, status);
        }
        return out;
    },

    /**
     * The finding issues among `issues` that a counted finding on their
     * package still *names*: its advisory is, or lists under `aliases`, the
     * issue's advisory — the identity's namesake, or the `vulnId` the user
     * acted on.
     *
     * The verify sweep's guard against an identity in flux. An identity moves
     * record by record (`db/identity-rekey.ts`): when `GO-X` gains its CVE
     * before `GHSA-Y` does, a package matching only `GO-X` now reports
     * `CVE-Z`, nothing on it reports `#GHSA-Y` any more, and an exact-key
     * check would call the issue on `#GHSA-Y` fixed. `GO-X` still lists
     * `GHSA-Y`, so it is still that bug — and the issue stays open until
     * `GHSA-Y`, the advisory it was written against, moves too and the re-key
     * carries it along.
     *
     * Returns issue ids. Reads the pre-collapse rows, because the collapse
     * keeps one advisory per finding and the naming one may be the one it
     * dropped.
     */
    async findingIssuesStillNamed(orgId: string, issues: Issue[]): Promise<Set<string>> {
        const named = new Set<string>();
        const keyed = issues.filter((i) => i.packageType && i.packageName && i.vulnIdentity);
        if (keyed.length === 0) return named;

        const counted = countedFindingRows(deployedImages(orgId));
        const rows = await db
            .selectDistinct({
                packageType: counted.packageType,
                packageName: counted.packageName,
                vulnId: counted.vulnId,
                aliases: counted.aliases,
            })
            .from(counted)
            .where(
                or(
                    ...keyed.map((i) =>
                        and(eq(counted.packageType, i.packageType!), eq(counted.packageName, i.packageName!))
                    )
                )
            );

        for (const issue of keyed) {
            const names = new Set(
                [issue.vulnIdentity!.replace(/^#/, ""), issue.vulnId].filter((n): n is string => !!n).map((n) => n.toUpperCase())
            );
            const hit = rows.some(
                (row) =>
                    row.packageType === issue.packageType &&
                    row.packageName === issue.packageName &&
                    [row.vulnId, ...(row.aliases ?? [])].some((id) => names.has(id.toUpperCase()))
            );
            if (hit) named.add(issue.id);
        }
        return named;
    },

    /** In-flight issues per image, for the rollup's issue link. */
    async openIssueCountsByImage(orgId: string): Promise<Map<string, number>> {
        const rows = await db
            .select({
                imageId: schema.issues.imageId,
                count: sql<number>`count(*)::int`,
            })
            .from(schema.issues)
            .where(
                and(
                    eq(schema.issues.orgId, orgId),
                    inArray(schema.issues.state, IN_FLIGHT_STATES)
                )
            )
            .groupBy(schema.issues.imageId);
        const out = new Map<string, number>();
        for (const row of rows) {
            if (row.imageId != null) out.set(row.imageId, row.count);
        }
        return out;
    },

    /** In-flight issues per release, for the chart-axis suggestions. */
    async openIssueCountsByRelease(orgId: string): Promise<Map<string, number>> {
        const rows = await db
            .select({
                releaseId: schema.issues.releaseId,
                count: sql<number>`count(*)::int`,
            })
            .from(schema.issues)
            .where(
                and(
                    eq(schema.issues.orgId, orgId),
                    inArray(schema.issues.state, IN_FLIGHT_STATES)
                )
            )
            .groupBy(schema.issues.releaseId);
        const out = new Map<string, number>();
        for (const row of rows) {
            if (row.releaseId != null) out.set(row.releaseId, row.count);
        }
        return out;
    },

    // ----- finding_states --------------------------------------------------

    /**
     * The collapsed identity for an advisory id — the same stored column the
     * counting surfaces read (`vulnerabilities.finding_identity`), looked up
     * once at write time so the read-time join is a plain column match.
     */
    async resolveVulnIdentity(vulnId: string): Promise<string | undefined> {
        const [row] = await db
            .select({ identity: findingIdentity })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, vulnId));
        return row?.identity;
    },

    /**
     * The collapsed identities of a batch of advisory rows by primary key —
     * the OSV sync's lookup when a fixed version lands. Same column read as
     * {@link resolveVulnIdentity}, evaluated set-wise.
     */
    async resolveIdentitiesByVulnerabilityIds(
        vulnerabilityIds: string[]
    ): Promise<Array<{ vulnerabilityId: string; vulnId: string; identity: string }>> {
        if (vulnerabilityIds.length === 0) return [];
        return db
            .select({
                vulnerabilityId: schema.vulnerabilities.id,
                vulnId: schema.vulnerabilities.vulnId,
                identity: findingIdentity,
            })
            .from(schema.vulnerabilities)
            .where(inArray(schema.vulnerabilities.id, vulnerabilityIds));
    },

    /**
     * Upsert on the finding key: re-suppressing an already-suppressed finding
     * updates the reason, owner and expiry rather than erroring — the common
     * case being an expiry extension, which deserves a fresh attribution.
     */
    async upsertFindingState(data: NewFindingState): Promise<FindingState> {
        const [result] = await db
            .insert(schema.findingStates)
            .values(data)
            .onConflictDoUpdate({
                target: [
                    schema.findingStates.orgId,
                    schema.findingStates.packageType,
                    schema.findingStates.packageName,
                    schema.findingStates.vulnIdentity,
                ],
                set: {
                    kind: data.kind,
                    vulnId: data.vulnId,
                    createdByUserId: data.createdByUserId,
                    createdByEmail: data.createdByEmail,
                    reason: data.reason,
                    expiresAt: data.expiresAt,
                    updatedAt: new Date(),
                },
            })
            .returning();
        return result!;
    },

    async listFindingStates(orgId: string): Promise<FindingState[]> {
        return db
            .select()
            .from(schema.findingStates)
            .where(eq(schema.findingStates.orgId, orgId))
            .orderBy(desc(schema.findingStates.createdAt));
    },

    async deleteFindingState(id: string, orgId: string): Promise<FindingState | undefined> {
        const [result] = await db
            .delete(schema.findingStates)
            .where(and(eq(schema.findingStates.id, id), eq(schema.findingStates.orgId, orgId)))
            .returning();
        return result;
    },

    // ----- activity_events -------------------------------------------------

    async appendEvent(data: NewActivityEvent, tx?: Transaction): Promise<ActivityEvent> {
        const [result] = await (tx ?? db).insert(schema.activityEvents).values(data).returning();
        return result!;
    },

    async listEvents(orgId: string, limit = 100): Promise<ActivityEvent[]> {
        return db
            .select()
            .from(schema.activityEvents)
            .where(eq(schema.activityEvents.orgId, orgId))
            .orderBy(desc(schema.activityEvents.createdAt))
            .limit(limit);
    },

    /**
     * The history-retention sweep for the activity feed: delete each org's
     * events older than its plan's `historyDays` window. The feed is a
     * history surface like trend snapshots and scan runs, and history windows
     * are real retention — so it is bounded by the same plan clock. Same
     * shape and same fail-safe as `metricsRepository.deleteBeyondPlanWindows`:
     * an unrecognised plan value deletes nothing.
     */
    async deleteEventsBeyondPlanWindows(): Promise<number> {
        let deleted = 0;
        for (const plan of Object.keys(PLAN_LIMITS) as PlanType[]) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - getPlanLimits(plan).historyDays);
            const orgsOnPlan = db
                .select({ id: schema.organizations.id })
                .from(schema.organizations)
                .where(eq(schema.organizations.plan, plan));
            const result = await db
                .delete(schema.activityEvents)
                .where(and(
                    lt(schema.activityEvents.createdAt, cutoff),
                    inArray(schema.activityEvents.orgId, orgsOnPlan)
                ))
                .returning({ id: schema.activityEvents.id });
            deleted += result.length;
        }
        return deleted;
    },

    /** One issue's lifecycle timeline, oldest first — the detail view's spine. */
    async listEventsForIssue(issueId: string, orgId: string): Promise<ActivityEvent[]> {
        return db
            .select()
            .from(schema.activityEvents)
            .where(
                and(
                    eq(schema.activityEvents.orgId, orgId),
                    eq(schema.activityEvents.issueId, issueId)
                )
            )
            .orderBy(schema.activityEvents.createdAt);
    },
};

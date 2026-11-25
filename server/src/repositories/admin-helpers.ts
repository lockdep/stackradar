/**
 * Predicates and small aggregations the admin repositories share. Three
 * surfaces answer the same questions — the Overview's counts, the Images
 * tab's filter and the SBOM explorer's badges — and spelling "awaiting an
 * SBOM" or "active advisory" twice is how two numbers end up under one
 * label. One definition each, imported by all of them.
 */

import { count, sql, isNull, isNotNull, eq, and, inArray, notExists, exists, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { currentGeneration, isCurrentGeneration } from "../db/generation.js";

export interface SeverityCounts {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
}

/**
 * What an admin should do about an image, as one word.
 *
 * The three are ordered by precedence, not by exclusivity — an image can be
 * orphaned *and* carry an SBOM (a cluster-free upload, or the remains of a
 * deleted cluster), and orphaned wins, because that is the fact with a deadline
 * attached. `hasSbom` and `containerCount` are reported alongside so nothing is
 * hidden by the collapse.
 */
export type AdminImageState = "orphaned" | "awaiting_sbom" | "scanned";

/**
 * Every mirror figure on this dashboard is read as "what the matcher can work
 * with", so every one of them excludes withdrawn advisories — the matcher will
 * not match against a retracted advisory, and counting them inflated the
 * headline mirror size past anything actually usable. The excluded advisories
 * are not hidden; `getWithdrawnStats()` reports them as their own figure.
 */
export const isActiveAdvisory = () => isNull(schema.vulnerabilities.withdrawnAt);
export const isWithdrawnAdvisory = () => isNotNull(schema.vulnerabilities.withdrawnAt);

/**
 * The affected-package equivalent: live generation *and* not withdrawn. The
 * generation half is mandatory for any read of this table (see db/generation.ts);
 * the withdrawn half is what keeps the entry counts consistent with the advisory
 * counts above.
 */
export const isActiveAffectedPackage = () =>
    and(isCurrentGeneration(), eq(schema.vulnerabilityAffectedPackages.withdrawn, false));

/** Advisories with no CVSS score — see AdminSystemStats.vulnerabilities.withoutCvssScore. */
export const isUnscoredAdvisory = () => and(isActiveAdvisory(), isNull(schema.vulnerabilities.cvssScore));

export const EMPTY_SEVERITY = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });

export function addSeverity(target: SeverityCounts, level: string | null, n: number) {
    switch (level) {
        case "critical":
            target.critical += n;
            break;
        case "high":
            target.high += n;
            break;
        case "medium":
            target.medium += n;
            break;
        case "low":
            target.low += n;
            break;
        default:
            target.unknown += n;
            break;
    }
}

/** Component counts grouped per SBOM. */
export async function componentCountsBySbom(sbomIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (sbomIds.length === 0) return map;
    const rows = await db
        .select({ sbomId: schema.components.sbomId, total: count() })
        .from(schema.components)
        .where(inArray(schema.components.sbomId, sbomIds))
        .groupBy(schema.components.sbomId);
    for (const r of rows) map.set(r.sbomId, Number(r.total));
    return map;
}

/** How many running containers reference each image, grouped in one pass. */
export async function deploymentCountsByImage(imageIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (imageIds.length === 0) return map;
    const rows = await db
        .select({ imageId: schema.workloadContainers.imageId, total: count() })
        .from(schema.workloadContainers)
        .where(inArray(schema.workloadContainers.imageId, imageIds))
        .groupBy(schema.workloadContainers.imageId);
    for (const r of rows) map.set(r.imageId, Number(r.total));
    return map;
}

/** Vulnerability severity counts grouped per SBOM, in a single pass. */
export async function severityCountsBySbom(sbomIds: string[]): Promise<Map<string, SeverityCounts>> {
    const bySbom = new Map<string, SeverityCounts>();
    if (sbomIds.length === 0) return bySbom;

    const rows = await db
        .select({
            sbomId: schema.components.sbomId,
            level: schema.vulnerabilities.severityLevel,
            total: count(),
        })
        .from(schema.componentVulnerabilities)
        .innerJoin(schema.components, eq(schema.componentVulnerabilities.componentId, schema.components.id))
        .innerJoin(
            schema.vulnerabilities,
            eq(schema.componentVulnerabilities.vulnerabilityId, schema.vulnerabilities.id),
        )
        .where(inArray(schema.components.sbomId, sbomIds))
        .groupBy(schema.components.sbomId, schema.vulnerabilities.severityLevel);

    for (const row of rows) {
        let counts = bySbom.get(row.sbomId);
        if (!counts) {
            counts = EMPTY_SEVERITY();
            bySbom.set(row.sbomId, counts);
        }
        addSeverity(counts, row.level, Number(row.total));
    }
    return bySbom;
}

/**
 * The three image states, as SQL predicates over `images`.
 *
 * Module scope because two surfaces ask the same question and must not answer
 * it differently: the Overview's counts and the Images tab's filter. Spelling
 * "awaiting an SBOM" as `total - withSbom` on one screen and as
 * "has containers and no SBOM" on the other would put two different numbers
 * under the same label — the orphaned-and-unscanned images fall in the gap.
 *
 * They partition `images` exactly once, in the precedence `AdminImageState`
 * documents: orphaned is unqualified and the other two both require a
 * container, so no image can satisfy two of them.
 */
export const IMAGE_STATE_FILTERS: Record<AdminImageState, SQL> = {
    orphaned: notExists(
        db
            .select({ one: sql`1` })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.imageId, schema.images.id)),
    ),
    awaiting_sbom: and(
        exists(
            db
                .select({ one: sql`1` })
                .from(schema.workloadContainers)
                .where(eq(schema.workloadContainers.imageId, schema.images.id)),
        ),
        notExists(
            db
                .select({ one: sql`1` })
                .from(schema.sboms)
                .where(eq(schema.sboms.imageId, schema.images.id)),
        ),
    )!,
    scanned: and(
        exists(
            db
                .select({ one: sql`1` })
                .from(schema.workloadContainers)
                .where(eq(schema.workloadContainers.imageId, schema.images.id)),
        ),
        exists(
            db
                .select({ one: sql`1` })
                .from(schema.sboms)
                .where(eq(schema.sboms.imageId, schema.images.id)),
        ),
    )!,
};

/**
 * Share one run of `fn` between every caller that arrives while it is in
 * flight. Not a cache — the moment the run settles the next caller starts a
 * fresh one, so nothing is ever served stale.
 *
 * It exists for the two mirror scans below. Each is a pass over a multi-GB
 * table, the admin page asks for them from several tabs at once, and a page
 * that is slow gets reloaded: without this every reload stacked another set
 * of scans behind the ones still running (Postgres does not cancel a query
 * because the browser gave up), until they ran each other into
 * `statement_timeout` and took the connection pool with them.
 */
function shareInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
    let inFlight: Promise<T> | null = null;
    return () => {
        inFlight ??= fn().finally(() => {
            inFlight = null;
        });
        return inFlight;
    };
}

/** Every whole-mirror advisory count the admin page shows. */
export interface MirrorAdvisoryCounts {
    /** Active (not withdrawn) advisories. */
    total: number;
    withdrawn: number;
    /** Active advisories per severity level; a null level is `unknown`. */
    bySeverity: Record<string, number>;
    /** Active advisories with no CVSS score. */
    withoutCvssScore: number;
    /** Advisories carrying an EPSS score, withdrawn or not (the Feeds figure). */
    withEpssScore: number;
    /** Advisories on the KEV list, withdrawn or not (the Feeds figure). */
    kevListed: number;
}

/**
 * All of the above in **one** pass over `vulnerabilities`.
 *
 * These used to be seven separate `count(*)` statements, each a sequential
 * scan of the whole heap (there is deliberately no index on `withdrawn_at`,
 * `cvss_score` or `epss_score`), all issued in parallel by a single Overview
 * load. `FILTER` aggregates answer the same questions from one scan, and the
 * predicates stay the shared ones so the figures cannot drift from the rest
 * of the dashboard.
 */
export const mirrorAdvisoryCounts = shareInFlight(async (): Promise<MirrorAdvisoryCounts> => {
    const rows = await db
        .select({
            level: schema.vulnerabilities.severityLevel,
            active: sql<string>`count(*) filter (where ${isActiveAdvisory()})`,
            withdrawn: sql<string>`count(*) filter (where ${isWithdrawnAdvisory()})`,
            unscored: sql<string>`count(*) filter (where ${isUnscoredAdvisory()})`,
            epss: sql<string>`count(*) filter (where ${isNotNull(schema.vulnerabilities.epssScore)})`,
            kev: sql<string>`count(*) filter (where ${isNotNull(schema.vulnerabilities.kevListedAt)})`,
        })
        .from(schema.vulnerabilities)
        .groupBy(schema.vulnerabilities.severityLevel);

    const counts: MirrorAdvisoryCounts = {
        total: 0,
        withdrawn: 0,
        bySeverity: {},
        withoutCvssScore: 0,
        withEpssScore: 0,
        kevListed: 0,
    };
    for (const row of rows) {
        const active = Number(row.active);
        counts.total += active;
        counts.withdrawn += Number(row.withdrawn);
        counts.withoutCvssScore += Number(row.unscored);
        counts.withEpssScore += Number(row.epss);
        counts.kevListed += Number(row.kev);
        // A level whose advisories are all withdrawn has no active rows; the
        // old `WHERE withdrawn_at IS NULL ... GROUP BY` never returned it.
        if (active > 0) counts.bySeverity[row.level ?? "unknown"] = active;
    }
    return counts;
});

export interface AffectedPackageGenerationCount {
    generation: number;
    /** Every row of the generation, withdrawn or not. */
    rowCount: number;
    /** Rows the matcher can use: `withdrawn = false`. */
    activeCount: number;
    isCurrent: boolean;
}

/**
 * `vulnerability_affected_packages` counted per generation, in one pass.
 *
 * Unscoped by generation on purpose — the one read in the codebase that is.
 * Every other reader must call isCurrentGeneration(); this one exists to show
 * what the others hide: a rebuild's progress, or rows orphaned by one that
 * died. There is no index on `generation`, so this is a sequential scan of
 * the table, which is why the Overview's "active entries" figure is read off
 * the same pass (`activeAffectedPackageCount`) instead of scanning it again.
 */
export const affectedPackageGenerationCounts = shareInFlight(async (): Promise<AffectedPackageGenerationCount[]> => {
    const rows = await db
        .select({
            generation: schema.vulnerabilityAffectedPackages.generation,
            total: count(),
            active: sql<string>`count(*) filter (where ${eq(schema.vulnerabilityAffectedPackages.withdrawn, false)})`,
            isCurrent: sql<boolean>`${schema.vulnerabilityAffectedPackages.generation} = ${currentGeneration()}`,
        })
        .from(schema.vulnerabilityAffectedPackages)
        .groupBy(schema.vulnerabilityAffectedPackages.generation)
        .orderBy(schema.vulnerabilityAffectedPackages.generation);

    return rows.map((r) => ({
        generation: r.generation,
        rowCount: Number(r.total),
        activeCount: Number(r.active),
        isCurrent: r.isCurrent === true,
    }));
});

/** Live-generation, not-withdrawn entries — `isActiveAffectedPackage()`, counted. */
export async function activeAffectedPackageCount(): Promise<number> {
    const generations = await affectedPackageGenerationCounts();
    return generations.find((g) => g.isCurrent)?.activeCount ?? 0;
}

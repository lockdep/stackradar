/**
 * Predicates and small aggregations the admin repositories share. Three
 * surfaces answer the same questions — the Overview's counts, the Images
 * tab's filter and the SBOM explorer's badges — and spelling "awaiting an
 * SBOM" or "active advisory" twice is how two numbers end up under one
 * label. One definition each, imported by all of them.
 */

import { count, sql, isNull, isNotNull, eq, and, inArray, notExists, exists, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isCurrentGeneration } from "../db/generation.js";

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

/**
 * The admin Matcher tab: how trustworthy the matcher's links are (confidence
 * and type distributions, cross-ecosystem matches) and the OSV records the
 * parser could not read. Platform-wide; never served past `requireAdmin`.
 */

import { count, sql, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { purlTypeForFamily } from "../matching/index.js";

/**
 * The key every match-metadata distribution uses for a NULL column.
 *
 * Not "unknown": these columns were added after the matcher was already writing
 * rows, so a null means the link predates the column rather than that the
 * matcher failed to decide. Those rows cannot be audited at all, which makes the
 * size of this bucket a figure in its own right — it shrinks to zero only once
 * every SBOM has been rescanned.
 */
export const UNRECORDED = "unrecorded";

/** One (OSV family → component PURL type) pair the matcher linked across. */
export interface AdminEcosystemDisagreement {
    /** The family part of `matched_ecosystem`: 'Alpine', 'Debian', 'npm'. */
    family: string;
    /** The PURL type that family is published under, per `matching/ecosystem.ts`. */
    expectedPurlType: string;
    /** The PURL type the component actually is. */
    componentPurlType: string;
    count: number;
}

export interface AdminMatcherQuality {
    /** Every row in `component_vulnerabilities` — the denominator for all of these. */
    total: number;
    /** 'direct' vs 'indirect' — did the component match itself, or its `upstream=` source package. */
    byMatchType: Record<string, number>;
    /** 'exact' / 'fuzzy' / 'unconfirmed' — how sure the version comparison was. */
    byMatchConfidence: Record<string, number>;
    /** 'purl' / 'cpe' / 'name_version' — which identity carried the match. */
    byMatchedBy: Record<string, number>;
    /**
     * Whether the advisory's ecosystem and the component's PURL type describe the
     * same kind of package.
     *
     * `matching/ecosystem.ts` maps each OSV family to exactly one PURL type, so
     * this comparison has a right answer: an advisory from `Alpine` belongs on an
     * `apk` component. A `golang` component carrying a `Debian` advisory is the
     * shape of a match-key or release-scoping leak, and it is invisible per
     * component — the Explorer shows one match at a time, and one crossed pair
     * looks like a curiosity rather than a class.
     */
    ecosystemAgreement: {
        agreeing: number;
        disagreeing: number;
        /** `matched_ecosystem` is null — provenance predates the column. */
        unrecorded: number;
        /**
         * Recorded, but one side maps to nothing: an OSV family outside the
         * `ECOSYSTEMS` table (`GitHub Actions`, `Linux`, `OSS-Fuzz`) or a component
         * with no parseable PURL. Neither is a defect — it is the set this question
         * cannot be asked of, kept separate so it never inflates either verdict.
         */
        unresolvable: number;
        /** Worst crossed pairs first. Capped — see `getMatcherQuality`. */
        topDisagreements: AdminEcosystemDisagreement[];
    };
}

export const adminMatcherRepository = {
    /**
     * The aggregate view of what the matcher has been doing.
     *
     * Every column here is already written on every link and already rendered per
     * component by the Explorer — but one match at a time cannot show a
     * regression. A rewrite that quietly demotes half the npm matches from `exact`
     * to `fuzzy` is four indistinguishable component pages and one obvious bar.
     *
     * Two queries, not five. The three distributions come from one grouped scan of
     * the whole cube (3 × 4 × 4 possible combinations, so the grouping is free)
     * and are folded apart here; splitting them into three queries would scan
     * `component_vulnerabilities` three times for the same rows.
     */
    async getMatcherQuality(disagreementLimit = 12): Promise<AdminMatcherQuality> {
        // Family, not the whole ecosystem string: 'Alpine:v3.23' and 'Alpine:v3.19'
        // are the same answer to "what kind of package is this", and grouping on the
        // raw string would spread one finding across every distro release.
        const family = sql<
            string | null
        >`nullif(split_part(${schema.componentVulnerabilities.matchedEcosystem}, ':', 1), '')`;
        // The PURL type is everything between 'pkg:' and the first '/'. A PURL that
        // does not start that way (including the legacy 'pkg://' form) yields null
        // and lands in `unresolvable` rather than being guessed at.
        const componentPurlType = sql<string | null>`lower(substring(${schema.components.purl} from '^pkg:([^/]+)'))`;

        const [cubeRows, pairRows] = await Promise.all([
            db
                .select({
                    matchType: schema.componentVulnerabilities.matchType,
                    matchConfidence: schema.componentVulnerabilities.matchConfidence,
                    matchedBy: schema.componentVulnerabilities.matchedBy,
                    total: count(),
                })
                .from(schema.componentVulnerabilities)
                .groupBy(
                    schema.componentVulnerabilities.matchType,
                    schema.componentVulnerabilities.matchConfidence,
                    schema.componentVulnerabilities.matchedBy,
                ),

            db
                .select({
                    family: family.as("family"),
                    componentPurlType: componentPurlType.as("component_purl_type"),
                    total: count(),
                })
                .from(schema.componentVulnerabilities)
                .innerJoin(schema.components, eq(schema.componentVulnerabilities.componentId, schema.components.id))
                .groupBy(family, componentPurlType),
        ]);

        const byMatchType: Record<string, number> = {};
        const byMatchConfidence: Record<string, number> = {};
        const byMatchedBy: Record<string, number> = {};
        let total = 0;

        for (const row of cubeRows) {
            const n = Number(row.total);
            total += n;
            const add = (target: Record<string, number>, key: string | null) => {
                const k = key ?? UNRECORDED;
                target[k] = (target[k] ?? 0) + n;
            };
            add(byMatchType, row.matchType);
            add(byMatchConfidence, row.matchConfidence);
            add(byMatchedBy, row.matchedBy);
        }

        let agreeing = 0;
        let disagreeing = 0;
        let unrecorded = 0;
        let unresolvable = 0;
        const topDisagreements: AdminEcosystemDisagreement[] = [];

        for (const row of pairRows) {
            const n = Number(row.total);

            if (row.family === null) {
                unrecorded += n;
                continue;
            }

            // The mapping lives in matching/ecosystem.ts and is resolved here rather
            // than in SQL so the table stays the single place a family is defined —
            // a VALUES list in this query would be a second copy that drifts silently.
            const expectedPurlType = purlTypeForFamily(row.family);
            if (!expectedPurlType || !row.componentPurlType) {
                unresolvable += n;
                continue;
            }

            if (expectedPurlType === row.componentPurlType) {
                agreeing += n;
            } else {
                disagreeing += n;
                topDisagreements.push({
                    family: row.family,
                    expectedPurlType,
                    componentPurlType: row.componentPurlType,
                    count: n,
                });
            }
        }

        topDisagreements.sort((a, b) => b.count - a.count);

        return {
            total,
            byMatchType,
            byMatchConfidence,
            byMatchedBy,
            ecosystemAgreement: {
                agreeing,
                disagreeing,
                unrecorded,
                unresolvable,
                // Capped for the table below it, not for the counts above — `disagreeing`
                // is the full figure, so a long tail is still visible as the gap between
                // it and the rows shown.
                topDisagreements: topDisagreements.slice(0, disagreementLimit),
            },
        };
    },

    async listParseFailures(limit: number, offset: number) {
        return db
            .select({
                id: schema.osvSyncFailures.id,
                syncRunId: schema.osvSyncFailures.syncRunId,
                syncMode: schema.osvSyncFailures.syncMode,
                osvId: schema.osvSyncFailures.osvId,
                ecosystemDir: schema.osvSyncFailures.ecosystemDir,
                sourcePath: schema.osvSyncFailures.sourcePath,
                errorType: schema.osvSyncFailures.errorType,
                occurredAt: schema.osvSyncFailures.occurredAt,
            })
            .from(schema.osvSyncFailures)
            .orderBy(desc(schema.osvSyncFailures.occurredAt))
            .limit(limit)
            .offset(offset);
    },

    async countParseFailures(): Promise<number> {
        const [row] = await db.select({ total: count() }).from(schema.osvSyncFailures);
        return Number(row?.total ?? 0);
    },

    async getParseFailureById(id: number) {
        const [row] = await db.select().from(schema.osvSyncFailures).where(eq(schema.osvSyncFailures.id, id));
        return row ?? null;
    },

    async deleteAllParseFailures(): Promise<number> {
        const result = await db.delete(schema.osvSyncFailures);
        return result.length ?? 0;
    },
};

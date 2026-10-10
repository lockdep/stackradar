/**
 * Data access for chart repositories and their cached `index.yaml` slices —
 * [fix-tab-suggestions.md](../../../docs/proposals/fix-tab-suggestions.md)
 * phase 2.
 *
 * The read path (`entriesForOrg`) serves the suggestion feed and touches only
 * enabled repositories; the write path is the daily sync in
 * `chart-repo.service.ts` plus the org-settings CRUD. Nothing here fetches —
 * fetching never happens in a request path.
 */

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type {
    ChartRepoVersion,
    ChartRepository,
    NewChartRepository,
} from "../db/schema/chart-repositories.js";

export interface ChartRepoEntryForOrg {
    repositoryId: string;
    repoUrl: string;
    chartName: string;
    versions: ChartRepoVersion[];
}

export const chartRepositoryRepository = {
    async listForOrg(orgId: string): Promise<ChartRepository[]> {
        return db
            .select()
            .from(schema.chartRepositories)
            .where(eq(schema.chartRepositories.orgId, orgId))
            .orderBy(schema.chartRepositories.url);
    },

    async findById(id: string, orgId: string): Promise<ChartRepository | undefined> {
        const [row] = await db
            .select()
            .from(schema.chartRepositories)
            .where(
                and(eq(schema.chartRepositories.id, id), eq(schema.chartRepositories.orgId, orgId))
            );
        return row;
    },

    async create(data: NewChartRepository): Promise<ChartRepository> {
        const [row] = await db.insert(schema.chartRepositories).values(data).returning();
        return row!;
    },

    async update(
        id: string,
        orgId: string,
        patch: Partial<Pick<ChartRepository, "enabled" | "username" | "password">>
    ): Promise<ChartRepository | undefined> {
        const [row] = await db
            .update(schema.chartRepositories)
            .set({ ...patch, updatedAt: new Date() })
            .where(
                and(eq(schema.chartRepositories.id, id), eq(schema.chartRepositories.orgId, orgId))
            )
            .returning();
        return row;
    },

    async delete(id: string, orgId: string): Promise<ChartRepository | undefined> {
        const [row] = await db
            .delete(schema.chartRepositories)
            .where(
                and(eq(schema.chartRepositories.id, id), eq(schema.chartRepositories.orgId, orgId))
            )
            .returning();
        return row;
    },

    /**
     * Auto-register repositories the inventory has observed on releases.
     * Insert-only, credential-less, and never resurrects: a URL the user
     * deleted or disabled keeps its row (the unique index makes the insert a
     * no-op), so an observed repo cannot re-enable itself.
     */
    async registerObserved(orgId: string, urls: string[]): Promise<number> {
        if (urls.length === 0) return 0;
        const rows = await db
            .insert(schema.chartRepositories)
            .values(urls.map((url) => ({ orgId, url, source: "observed" as const })))
            .onConflictDoNothing({
                target: [schema.chartRepositories.orgId, schema.chartRepositories.url],
            })
            .returning({ id: schema.chartRepositories.id });
        return rows.length;
    },

    /**
     * Auto-register repositories the attribution pass matched with version
     * evidence (`source: "artifact-hub-matched"`). Same non-resurrection
     * contract as `registerObserved`: a URL the user deleted or disabled
     * keeps its row, so a match cannot re-enable it.
     */
    async registerMatched(orgId: string, urls: string[]): Promise<number> {
        if (urls.length === 0) return 0;
        const rows = await db
            .insert(schema.chartRepositories)
            .values(urls.map((url) => ({ orgId, url, source: "artifact-hub-matched" as const })))
            .onConflictDoNothing({
                target: [schema.chartRepositories.orgId, schema.chartRepositories.url],
            })
            .returning({ id: schema.chartRepositories.id });
        return rows.length;
    },

    /** Every enabled repository across all orgs — the sync job's worklist. */
    async listAllEnabled(): Promise<ChartRepository[]> {
        return db
            .select()
            .from(schema.chartRepositories)
            .where(eq(schema.chartRepositories.enabled, true));
    },

    async recordFetch(
        id: string,
        outcome: { etag?: string | null; lastFetchError: string | null }
    ): Promise<void> {
        const now = new Date();
        await db
            .update(schema.chartRepositories)
            .set({
                ...(outcome.etag !== undefined ? { etag: outcome.etag } : {}),
                lastFetchedAt: now,
                lastFetchError: outcome.lastFetchError,
                updatedAt: now,
            })
            .where(eq(schema.chartRepositories.id, id));
    },

    /**
     * Replace one repository's cached entries with what the fetch produced.
     * Same stamp-and-prune shape as the inventory write: rows the fetch did
     * not mention are stale and deleted.
     */
    async replaceEntries(
        repositoryId: string,
        entries: Array<{ chartName: string; versions: ChartRepoVersion[] }>,
        fetchedAt: Date
    ): Promise<void> {
        await db.transaction(async (tx) => {
            if (entries.length > 0) {
                await tx
                    .insert(schema.chartRepoEntries)
                    .values(
                        entries.map((e) => ({
                            repositoryId,
                            chartName: e.chartName,
                            versions: e.versions,
                            fetchedAt,
                        }))
                    )
                    .onConflictDoUpdate({
                        target: [
                            schema.chartRepoEntries.repositoryId,
                            schema.chartRepoEntries.chartName,
                        ],
                        set: {
                            versions: sql`excluded.versions`,
                            fetchedAt,
                            updatedAt: fetchedAt,
                        },
                    });
            }
            await tx
                .delete(schema.chartRepoEntries)
                .where(
                    and(
                        eq(schema.chartRepoEntries.repositoryId, repositoryId),
                        lt(schema.chartRepoEntries.fetchedAt, fetchedAt)
                    )
                );
        });
    },

    /** The suggestion feed's read: enabled repositories' entries, flat. */
    async entriesForOrg(orgId: string): Promise<ChartRepoEntryForOrg[]> {
        return db
            .select({
                repositoryId: schema.chartRepoEntries.repositoryId,
                repoUrl: schema.chartRepositories.url,
                chartName: schema.chartRepoEntries.chartName,
                versions: schema.chartRepoEntries.versions,
            })
            .from(schema.chartRepoEntries)
            .innerJoin(
                schema.chartRepositories,
                eq(schema.chartRepoEntries.repositoryId, schema.chartRepositories.id)
            )
            .where(
                and(
                    eq(schema.chartRepositories.orgId, orgId),
                    eq(schema.chartRepositories.enabled, true)
                )
            );
    },

    /** Distinct chart names an org's releases run — the sync's trim set. */
    async chartNamesForOrg(orgId: string): Promise<string[]> {
        const rows = await db
            .selectDistinct({ chartName: schema.helmReleases.chartName })
            .from(schema.helmReleases)
            .where(eq(schema.helmReleases.orgId, orgId));
        return rows.map((r) => r.chartName).filter((n): n is string => n != null);
    },

    /**
     * Chart names the org runs whose releases carry no `repoUrl` — the
     * discovery worklist the settings page offers Artifact Hub lookups for.
     */
    async chartNamesWithUnknownRepo(orgId: string): Promise<string[]> {
        const rows = await db
            .selectDistinct({ chartName: schema.helmReleases.chartName })
            .from(schema.helmReleases)
            .where(
                and(
                    eq(schema.helmReleases.orgId, orgId),
                    sql`${schema.helmReleases.repoUrl} IS NULL`,
                    sql`${schema.helmReleases.chartName} IS NOT NULL`
                )
            );
        return rows
            .map((r) => r.chartName)
            .filter((n): n is string => n != null)
            .sort();
    },

    /** Distinct observed `repoUrl`s on an org's releases, for auto-registration. */
    async observedRepoUrls(orgId: string): Promise<string[]> {
        const rows = await db
            .selectDistinct({ repoUrl: schema.helmReleases.repoUrl })
            .from(schema.helmReleases)
            .where(eq(schema.helmReleases.orgId, orgId));
        return rows.map((r) => r.repoUrl).filter((u): u is string => u != null);
    },

    /** Orgs that have any release — the sync job's outer loop. */
    async orgIdsWithReleases(): Promise<string[]> {
        const rows = await db
            .selectDistinct({ orgId: schema.helmReleases.orgId })
            .from(schema.helmReleases);
        return rows.map((r) => r.orgId);
    },

    /** Orgs with any registered repository (kept in the loop even release-less). */
    async orgIdsWithRepositories(): Promise<string[]> {
        const rows = await db
            .selectDistinct({ orgId: schema.chartRepositories.orgId })
            .from(schema.chartRepositories);
        return rows.map((r) => r.orgId);
    },

    /** Delete cached entries for repositories that were disabled or removed. */
    async pruneEntriesForDisabled(): Promise<void> {
        const disabled = db
            .select({ id: schema.chartRepositories.id })
            .from(schema.chartRepositories)
            .where(eq(schema.chartRepositories.enabled, false));
        await db
            .delete(schema.chartRepoEntries)
            .where(inArray(schema.chartRepoEntries.repositoryId, disabled));
    },
};

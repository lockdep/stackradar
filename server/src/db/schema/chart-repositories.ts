import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Chart repository awareness.
 *
 * A chart repository is an `index.yaml` URL plus optional credentials. One
 * implementation covers Bitnami, ChartMuseum, Harbor, GitHub-Pages-hosted
 * repos — everything HTTP. What it feeds is the **unmeasured** band of the
 * suggestion feed: an index can honestly say *a newer chart exists*; it can
 * never say what upgrading fixes, and nothing built on these tables may
 * imply otherwise.
 *
 * Rows can also be auto-added by the nightly attribution pass
 * (`artifact-hub-matched`). That does not weaken the trust rule above —
 * matched rows exist only on version-list identity evidence, and what they
 * feed is still only the unmeasured band.
 *
 * Credentials are held server-side — the simplest answer, taken knowingly:
 * the fetch is metadata-only, but it does
 * diverge from the in-cluster precedent registry pulls set. Revisit before
 * production.
 */

export const CHART_REPOSITORY_SOURCES = [
    "observed",
    "manual",
    "artifact-hub-confirmed",
    "artifact-hub-matched",
] as const;
export type ChartRepositorySource = (typeof CHART_REPOSITORY_SOURCES)[number];

export const chartRepositories = pgTable(
    "chart_repositories",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),

        /** The repository root; `index.yaml` is fetched relative to it. */
        url: text("url").notNull(),
        /**
         * How the row came to exist. `observed` rows are auto-registered from
         * `helm_releases.repoUrl` and carry no credentials. `artifact-hub-confirmed`
         * rows exist only after the *user* confirmed a discovery result — a
         * name-only API match is a guess and is never trusted silently.
         * `artifact-hub-matched` rows are auto-added by the nightly attribution
         * pass, trusted for the unmeasured band only because they carry
         * version-list identity evidence (`lib/chart-attribution.ts`) — never a
         * bare name match. Like `observed`, it is not creatable through the API:
         * `chart-repository.schema.ts` keeps rejecting it on requests, because a
         * request claiming machine-gathered evidence has none.
         */
        source: varchar("source", { length: 30 }).notNull().$type<ChartRepositorySource>(),
        enabled: boolean("enabled").notNull().default(true),

        /** Optional HTTP basic auth for private hubs. */
        username: varchar("username", { length: 255 }),
        password: text("password"),

        /* Fetch bookkeeping. `etag` is what keeps a Bitnami-scale index cheap:
       the daily refresh is a conditional GET, and 304 costs nothing. */
        etag: varchar("etag", { length: 255 }),
        lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
        /** `null` = last fetch succeeded (or none yet). Shown in settings. */
        lastFetchError: text("last_fetch_error"),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [uniqueIndex("chart_repositories_org_url_unique").on(table.orgId, table.url)],
);

export type ChartRepository = typeof chartRepositories.$inferSelect;
export type NewChartRepository = typeof chartRepositories.$inferInsert;

export interface ChartRepoVersion {
    version: string;
    appVersion: string | null;
    /**
     * First `urls` entry from `index.yaml`, resolved absolute against the repo
     * URL when relative (as the Helm client resolves it). What the
     * `chart_render` worker fetches. Null for entries cached before this field existed, or an index that
     * lists none; a version without one simply cannot be rendered.
     */
    tarballUrl: string | null;
}

/**
 * The cached slice of a repository's `index.yaml`: one row per chart the org
 * actually runs, newest versions first as the index listed them.
 *
 * Deliberately a *slice*. Bitnami's index is tens of megabytes describing
 * hundreds of charts; the org runs a handful. The sync trims at write time,
 * so the read path — the suggestion feed — never touches anything but rows
 * that can possibly match a release.
 */
export const chartRepoEntries = pgTable(
    "chart_repo_entries",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        repositoryId: uuid("repository_id")
            .notNull()
            .references(() => chartRepositories.id, { onDelete: "cascade" }),

        chartName: varchar("chart_name", { length: 253 }).notNull(),
        /** Versions as listed, capped by the sync — see `chart-repo.ts`. */
        versions: jsonb("versions").notNull().$type<ChartRepoVersion[]>(),

        fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("chart_repo_entries_repo_chart_unique").on(table.repositoryId, table.chartName),
        index("chart_repo_entries_chart_name_idx").on(table.chartName),
    ],
);

import {
    pgTable,
    uuid,
    varchar,
    text,
    integer,
    boolean,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The Artifact Hub mirror.
 *
 * A nightly copy of Artifact Hub's `/api/v1/nova` dump: every Helm package the
 * hub knows, with its repository and version list. **Global tables** — the dump
 * describes the public chart ecosystem, not any tenant, so there is no
 * `org_id` and nothing here is tenant data. Tenancy enters only in
 * `chart_attributions`, which maps an org's installed charts onto
 * these rows.
 *
 * The mirror exists because 1,963 of the dump's 12,404 chart names are claimed
 * by more than one repository — attribution needs the *whole* candidate set
 * with evidence to score, not a per-name search call. It doubles as the only
 * version-availability source for OCI-hosted repositories, which serve no
 * `index.yaml`.
 */

/** One entry of a package's version list, normalised from the dump. */
export interface ArtifactHubVersion {
    /** The chart version (`version` in Chart.yaml). */
    pkg: string;
    /** `appVersion`, when the chart declares one. */
    app: string | null;
    /** `kubeVersion` constraint (Masterminds semver range), when declared. */
    kube: string | null;
    deprecated: boolean;
}

export const artifactHubPackages = pgTable(
    "artifact_hub_packages",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        /** Chart name — the matcher's lookup key. Not unique: name collisions are the point. */
        name: varchar("name", { length: 253 }).notNull(),
        /** Artifact Hub's repository slug. `(repo_name, name)` is the dump's natural key. */
        repoName: varchar("repo_name", { length: 253 }).notNull(),
        /** The Helm repository URL — `https://…` or `oci://…`. */
        repoUrl: text("repo_url").notNull(),

        description: text("description"),
        latestVersion: varchar("latest_version", { length: 128 }),
        stars: integer("stars").notNull().default(0),
        /** Repository-level flags: the publisher owns the repo / Artifact Hub verified it. */
        repoOfficial: boolean("repo_official").notNull().default(false),
        repoVerified: boolean("repo_verified").notNull().default(false),
        /** Package-level official flag. */
        official: boolean("official").notNull().default(false),
        homeUrl: text("home_url"),

        /** The version list, newest ordering as the dump gave it. */
        versions: jsonb("versions").notNull().$type<ArtifactHubVersion[]>(),

        /** Stamp-and-prune stamp: rows a sync did not mention are deleted. */
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("artifact_hub_packages_repo_name_unique").on(table.repoName, table.name),
        index("artifact_hub_packages_name_idx").on(table.name),
    ],
);

/**
 * Artifact Hub sync state — one row, `id = 1`, the `epss_sync_state` shape.
 *
 * The attribution counters are written by the phase-2 pass that runs in the
 * same cron directly after the mirror refresh; they are null until it exists
 * or when a run fails before reaching it.
 */
export const artifactHubSyncState = pgTable("artifact_hub_sync_state", {
    id: integer("id").primaryKey().default(1),

    /** Completion of the last successful run — what the 23-hour guard reads. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),

    /** Entries in the downloaded dump, before parsing dropped anything. */
    packagesInDump: integer("packages_in_dump"),
    /** Rows upserted into the mirror (post-dedupe, post-malformed-skip). */
    packagesApplied: integer("packages_applied"),

    /** Distinct `(org, chart)` pairs the attribution pass examined. */
    chartsExamined: integer("charts_examined"),
    attributionsWritten: integer("attributions_written"),
    attributionsRefused: integer("attributions_refused"),
    reposAutoAdded: integer("repos_auto_added"),

    /** Null when the last run succeeded. */
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

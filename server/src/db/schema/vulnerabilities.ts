import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, real, boolean, primaryKey, foreignKey, index, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { components } from "./components.js";
import { ADVISORY_RISK_SQL } from "../risk-model.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
    dataType() { return "bytea"; },
});

// ===== OSV-Compliant Types =====

/**
 * OSV severity entry - stores CVSS vectors
 * @see https://ossf.github.io/osv-schema/#severity-field
 */
export interface OsvSeverityEntry {
    type: "CVSS_V2" | "CVSS_V3" | "CVSS_V4";
    score: string; // CVSS vector string, e.g., "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:N/A:N"
}

/**
 * OSV reference entry
 * @see https://ossf.github.io/osv-schema/#references-field
 */
export interface OsvReference {
    type: "ADVISORY" | "ARTICLE" | "DETECTION" | "DISCUSSION" | "REPORT" | "FIX" | "INTRODUCED" | "PACKAGE" | "EVIDENCE" | "WEB";
    url: string;
}

/**
 * OSV credit entry
 * @see https://ossf.github.io/osv-schema/#credits-fields
 */
export interface OsvCredit {
    name: string;
    contact?: string[];
    type?: "FINDER" | "REPORTER" | "ANALYST" | "COORDINATOR" | "REMEDIATION_DEVELOPER" | "REMEDIATION_REVIEWER" | "REMEDIATION_VERIFIER" | "TOOL" | "SPONSOR" | "OTHER";
}

/**
 * OSV range event - each event is a single object with one property
 * @see https://ossf.github.io/osv-schema/#affectedrangesevents-fields
 */
export interface OsvRangeEvent {
    introduced?: string;
    fixed?: string;
    last_affected?: string;
    limit?: string;
}

/**
 * OSV version range with type and events
 * @see https://ossf.github.io/osv-schema/#affectedranges-field
 */
export interface OsvRange {
    type: "SEMVER" | "ECOSYSTEM" | "GIT";
    repo?: string | undefined; // Required for GIT type
    events: OsvRangeEvent[];
    database_specific?: Record<string, unknown> | undefined;
}

// ===== Database Tables =====

/**
 * Core vulnerability record - unified schema for all sources (NVD, OSV, GitHub, etc.)
 * Field names align with OSV schema where possible.
 * @see https://ossf.github.io/osv-schema/
 */
export const vulnerabilities = pgTable("vulnerabilities", {
    id: uuid("id").primaryKey().defaultRandom(),

    // OSV: id field - Primary identifier (CVE-2024-1234, GHSA-xxxx, OSV-2020-111, etc.)
    vulnId: varchar("vuln_id", { length: 100 }).notNull().unique(),

    // Derived from vulnId — the prefix before the first dash (CVE, GHSA, PYSEC, RUSTSEC, ALPINE, …)
    idPrefix: varchar("id_prefix", { length: 50 }).generatedAlwaysAs(sql`SPLIT_PART(vuln_id, '-', 1)`),

    // OSV: schema_version - Track which OSV schema version this was imported from
    schemaVersion: varchar("schema_version", { length: 20 }),

    // Source tracking (not in OSV, but useful for multi-source aggregation)
    source: varchar("source", { length: 50 }).notNull(), // 'osv', 'nvd', 'github', 'snyk'
    sourceUrl: text("source_url"),

    // OSV: summary - One-line textual summary (recommended <= 120 chars)
    summary: varchar("summary", { length: 512 }),

    // OSV: details - CommonMark markdown details
    details: text("details"),

    // OSV: severity - Array of {type, score} objects
    // @see https://ossf.github.io/osv-schema/#severity-field
    severity: jsonb("severity").$type<OsvSeverityEntry[]>().default([]),

    // Derived severity level for easier querying (not in OSV, computed from CVSS)
    severityLevel: varchar("severity_level", { length: 20 }), // 'critical', 'high', 'medium', 'low', 'unknown'

    // CVSS base score (0.0 – 10.0), null when no score is computable
    cvssScore: real("cvss_score"),

    /**
     * Null when `severity_level` / `cvss_score` are this record's own. When
     * the record publishes no severity at all, it is the `vuln_id` of the
     * record with the same `finding_identity` those two were copied from —
     * `GO-2026-4918` carrying `CVE-2026-33814`'s 7.5, because the Go vuln DB
     * never states CVSS. Written only by `osv-sync/severity-fill.ts`, and
     * reset to null by every OSV upsert, which restates the record's own
     * values; the fill then runs again for the identity. See that file for
     * which record wins.
     */
    severitySource: varchar("severity_source", { length: 100 }),

    // ===== Exploitation signal =====
    //
    // CVSS says how bad this is if exploited. Neither of the next two is
    // derivable from it, and between them they are what turns a severity list
    // into a priority list. Both are maintained by their own daily syncs
    // (`epss-sync/`, `kev-sync/`) and are deliberately absent from every
    // column list in `vulnerability.repository.ts` — an OSV refresh restates
    // the advisory, and must not blank the threat intelligence attached to it.

    /**
     * FIRST.org's predicted probability this CVE is exploited in the next 30
     * days, 0.0–1.0. Null for advisories EPSS does not cover: no CVE id and no
     * CVE alias, which is every `MAL-*` and a long tail of `GHSA-*`. Null is
     * the honest value and `risk_score` has a documented rule for it — see
     * `UNSCORED_EXPLOITABILITY`. Never default it to zero.
     */
    epssScore: real("epss_score"),

    /**
     * Where that score ranks among all scored CVEs, 0.0–1.0. Display only:
     * "0.87 (99th pct)" is how a human reads a probability, but percentile is
     * uniform by construction and makes a terrible weight, so `risk_score`
     * uses `epss_score` instead. See `risk-model.ts` § exploitability.
     */
    epssPercentile: real("epss_percentile"),

    /** When the EPSS sync last wrote the two columns above. Staleness is a UI concern. */
    epssUpdatedAt: timestamp("epss_updated_at", { withTimezone: true }),

    /**
     * When CISA added this CVE to the Known Exploited Vulnerabilities
     * catalogue — `dateAdded`, not when we synced it.
     *
     * A timestamp rather than a boolean because the two questions "is this
     * exploited" and "how long have we known" have the same answer here, and a
     * boolean throws the second away. Null means "not on the catalogue", which
     * for a non-CVE advisory also means "could not be".
     */
    kevListedAt: timestamp("kev_listed_at", { withTimezone: true }),

    /**
     * CISA's remediation deadline for federal agencies. Not our SLA and not a
     * promise to anyone — carried because it is the only externally published
     * due date a finding ever has, and a customer with a compliance regime
     * wants to see it. Label it as CISA's in the UI.
     */
    kevDueDate: timestamp("kev_due_date", { withTimezone: true }),

    /** CISA's `knownRansomwareCampaignUse` field, verbatim: "Known" or "Unknown". */
    kevRansomware: varchar("kev_ransomware", { length: 16 }),

    /**
     * Likelihood × consequence, 0–100. **Generated, never written.**
     *
     * The whole formula and the reasoning behind every constant in it live in
     * [`risk-model.ts`](../risk-model.ts); this column is that expression
     * compiled into the table so it cannot disagree with its own inputs. Three
     * things follow from it being generated rather than stored:
     *
     * - There is no recompute job. Postgres re-evaluates the expression on any
     *   UPDATE to the row, so the daily EPSS sync *is* the recomputation, and
     *   an advisory whose CVSS is revised by an OSV refresh re-scores in the
     *   same statement.
     * - It cannot be stale, backfilled wrong, or written by a caller who had a
     *   different idea. The failure mode where a score outlives the data it was
     *   computed from is not reachable.
     * - It is indexable, should a whole-mirror top-N ever be wanted; today
     *   every ordering by it is within a scope's findings, so it carries no
     *   index (db plan item 6).
     *
     * Note it is a property of the *advisory*, not of a finding, and carries no
     * exposure term — see the two-layer argument in `risk-model.ts`. Rolling
     * these up for a workload is `aggregateRiskSql`, applied at read time.
     */
    riskScore: real("risk_score").generatedAlwaysAs(sql.raw(ADVISORY_RISK_SQL)),

    // OSV: aliases - List of IDs in other databases
    aliases: jsonb("aliases").$type<string[]>().default([]),

    /**
     * The cross-image finding identity — which advisories are the same
     * vulnerability. `CVE-…` when the record is or names exactly one CVE;
     * with no CVE at all, `#GHSA-…` when it and its aliases hold exactly one
     * GitHub advisory; otherwise `#<vuln_id>`, standing alone.
     *
     * A pure function of `(vuln_id, aliases, upstream)` — `upstream` read off
     * `raw_data`, since a distro tracker entry (`UBUNTU-CVE-…`) names its CVE
     * there and nowhere else — materialised so the counting
     * surfaces (`db/findings.ts#collapsedFindings`) and the `finding_states` /
     * `issues` joins read a column instead of re-deriving it per finding row
     * with a correlated alias scan. Not a generated column only because the
     * derivation needs a subquery over `aliases`; instead it is written the way
     * `ecosystem_family` is on `vulnerability_affected_packages` — computed at
     * ingest (`lib/vulnerability-aliases.ts#findingIdentityOf`, called from
     * `convertOsvRecordToVulnerability`) and rewritten by the OSV sync whenever
     * the advisory changes, which is the only path that writes these rows.
     * `tests/integration/findings/finding-identity.test.ts` holds the stored
     * value, the TypeScript function and the original SQL derivation together.
     *
     * Nullable only for rows that predate the column; the backfill migration
     * populates them and every sync write supplies it. Readers assert
     * non-null (`db/findings.ts#findingIdentity`).
     */
    findingIdentity: text("finding_identity"),

    // OSV: related - List of closely related vulnerability IDs
    related: jsonb("related").$type<string[]>().default([]),

    // OSV: references - List of reference URLs
    references: jsonb("references").$type<OsvReference[]>().default([]),

    // OSV: credits - List of credits
    credits: jsonb("credits").$type<OsvCredit[]>().default([]),

    // OSV: database_specific - Database-specific fields (e.g., cwe_ids from GitHub)
    databaseSpecific: jsonb("database_specific").$type<Record<string, unknown>>(),

    // OSV: published, modified, withdrawn timestamps
    publishedAt: timestamp("published_at", { withTimezone: true }),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),

    // Raw data from source (full OSV record for reference)
    rawData: jsonb("raw_data"),

    // SHA-256 hash of rawData bytes — used by OSV sync for change detection
    rawHash: bytea("raw_hash"),

    // Internal tracking
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    // GROUP BY id_prefix in getAdvisoryIdDistribution — generated column, no index by default
    index("vulnerabilities_id_prefix_idx").on(table.idPrefix),
    // No index on `cvss_score` or `risk_score`: every ordering by either is
    // over a scope's findings (a join from `component_vulnerabilities`),
    // never a top-N over the whole mirror, so the planner never chose them —
    // zero scans since 2026-08-25 for 150 MB rewritten on every OSV sync
    // batch (db plan item 6).
    // "Everything on the KEV catalogue" — a few thousand rows out of ~300k, and
    // the one query that must never degrade to a seq scan because it backs a
    // badge on every findings list. Partial for the same reason
    // `vulnerabilities_withdrawn_at_idx` is: the complement matches nearly
    // every row and is not worth indexing.
    index("vulnerabilities_kev_listed_at_idx")
        .on(table.kevListedAt)
        .where(sql`${table.kevListedAt} IS NOT NULL`),
    // GROUP BY severity_level / source in dashboard counts. Low cardinality
    // but cheap, and avoids a HashAggregate over the full table. See
    // docs/db-audit/P1-missing-indexes.md § P1-7.
    index("vulnerabilities_severity_level_idx").on(table.severityLevel),
    index("vulnerabilities_source_idx").on(table.source),
    // Recently-modified advisories ordering. Drizzle emits ASC by default;
    // the SQL migration should flip this to DESC to match the query.
    index("vulnerabilities_modified_at_idx").on(table.modifiedAt),
    // No GIN index on `aliases`: nothing queries the column with a
    // containment operator — the cross-reference lookups read `aliases` off
    // rows already found by id, and the rule-5 `?` test in `db/findings.ts`
    // is over an expression (`aliases || related`) a column index cannot
    // serve (db plan item 6).
    // The collapse key. Equality lookups (the Vulnerabilities tab drill-downs
    // filter `finding_identity = $1`, `finding_states` / `issues` join on it)
    // and the GROUP BY in every counting surface both want the plain b-tree.
    index("vulnerabilities_finding_identity_idx").on(table.findingIdentity),
    // "Which records borrowed their severity from these" — the severity fill's
    // scope lookup on every incremental batch (`osv-sync/severity-fill.ts`).
    // Partial: most records carry their own severity.
    index("vulnerabilities_severity_source_idx")
        .on(table.severitySource)
        .where(sql`${table.severitySource} IS NOT NULL`),
    // No index on `withdrawn_at`, partial or otherwise: the admin withdrawn
    // panel is the only reader and the planner never used the partial index
    // for it (zero scans since 2026-08-25). Deliberately no index for the
    // complementary `withdrawn_at IS NULL` either: that predicate matches
    // nearly every row, so a seq scan is the right plan (db plan item 6).
]);

/**
 * Affected packages - which package versions are vulnerable
 * Maps to OSV affected[] array entries.
 * @see https://ossf.github.io/osv-schema/#affected-fields
 */
export const vulnerabilityAffectedPackages = pgTable("vulnerability_affected_packages", {
    id: uuid("id").primaryKey().defaultRandom(),
    vulnerabilityId: uuid("vulnerability_id").notNull(), // indexed below

    // OSV: affected[].package.ecosystem - Must be a defined ecosystem
    // @see https://ossf.github.io/osv-schema/#affectedpackage-field
    ecosystem: varchar("ecosystem", { length: 100 }), // 'npm', 'PyPI', 'Maven', 'Go', 'crates.io', etc.

    // The ecosystem string split at its first colon: 'Red Hat:enterprise_linux:8::appstream'
    // becomes family 'Red Hat' + release 'enterprise_linux:8::appstream'. Stored apart so
    // release scoping is a SQL filter rather than a post-filter over 587k Red Hat rows.
    // Null release means the advisory names no distro release and applies family-wide.
    ecosystemFamily: varchar("ecosystem_family", { length: 64 }),
    ecosystemRelease: varchar("ecosystem_release", { length: 128 }),

    // The distro version named by `ecosystem_release`, as `matching/ecosystem.ts#releaseVersion`
    // reads it: 'Ubuntu:22.04:LTS' → '22.04', 'Alpine:v3.23' → '3.23',
    // 'Red Hat:enterprise_linux:8::appstream' → '8'. Written by the OSV sync at
    // ingest (parser.ts) with that TypeScript function, never derived in SQL, so
    // the store's predicate and the matcher's in-memory check cannot disagree.
    // Null for language ecosystems and for releases naming no version; a null
    // row is admitted for every component, which is also what makes a
    // not-yet-backfilled row safe (it merely leaves the in-memory guard to do
    // the work, as before the column existed). See db plan item 4.
    releaseVersion: varchar("release_version", { length: 64 }),

    // OSV: affected[].package.name
    packageName: varchar("package_name", { length: 512 }).notNull(),

    // OSV: affected[].package.purl - Package URL (optional but recommended)
    purl: text("purl"),

    // The canonical match key from matching/identity.ts, computed identically here at
    // ingest and on the component PURL at match time. This is the hot lookup column.
    // Changing any key rule in identity.ts requires re-ingesting the mirror.
    matchKey: text("match_key").notNull(),

    // Denormalized from vulnerabilities.withdrawn_at so the hot lookup needs no join.
    // A withdrawn advisory must never produce a match; both sync paths derive this
    // from the OSV record at extract time, so a withdrawal during an incremental sync
    // flips the flag when replaceForVulns re-inserts the rows.
    withdrawn: boolean("withdrawn").notNull().default(false),

    // OSV: affected[].ranges - Version ranges with proper OSV structure
    // @see https://ossf.github.io/osv-schema/#affectedranges-field
    ranges: jsonb("ranges").$type<OsvRange[]>().default([]),

    // OSV: affected[].versions - Explicit list of affected versions
    versions: jsonb("versions").$type<string[]>().default([]),

    // OSV: affected[].database_specific
    databaseSpecific: jsonb("database_specific").$type<Record<string, unknown>>(),

    // Derived fields for easier querying (computed from ranges)
    fixedVersion: varchar("fixed_version", { length: 255 }),

    // Which rebuild of the mirror this row belongs to. A bootstrap writes an
    // entire new generation alongside the live one and only then moves the
    // pointer in osv_sync_state.affected_pkg_generation, so a rebuild that dies
    // half-way leaves the previous generation serving instead of an empty table.
    // Every read must be scoped with `isCurrentGeneration()` (src/db/generation.ts);
    // an unscoped read sees both generations during a rebuild and double-counts.
    generation: integer("generation").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({
        name: "vuln_affected_pkg_vuln_fk",
        columns: [table.vulnerabilityId],
        foreignColumns: [vulnerabilities.id],
    }).onDelete("cascade"),
    index("vuln_affected_pkg_vuln_id_pkg_name_idx").on(table.vulnerabilityId, table.packageName),
    // The matcher's hot path. Partial on `withdrawn = false` because a withdrawn
    // advisory is never a candidate — keeping those rows out of the index makes it
    // both smaller and the exclusion unforgettable. `release_version` is the
    // second column so a distro component's lookup is `(key, release)` and the
    // 18 other releases of `deb/ubuntu|linux` are never fetched; a lookup by
    // key alone still uses the leading column. Replaced the single-column
    // `vuln_affected_pkg_match_key_idx` (db plan item 4). The old
    // (purl_type, purl_name) index is gone: nothing queried it, and match_key
    // supersedes it as the lookup key.
    index("vuln_affected_pkg_match_key_release_idx")
        .on(table.matchKey, table.releaseVersion)
        .where(sql`${table.withdrawn} = false`),
    // No index on `generation`: the only readers by generation alone are the
    // two sweeps (promote / discard), one sequential pass per rebuild, and
    // the 74 MB index cost a write on every one of the ~7M rows a rebuild
    // inserts for a single scan it never needed (db plan item 6).
]);

/**
 * Link vulnerabilities to components (computed after matching)
 * This is application-specific, not part of OSV schema.
 */
export const componentVulnerabilities = pgTable("component_vulnerabilities", {
    componentId: uuid("component_id").notNull(),
    vulnerabilityId: uuid("vulnerability_id").notNull(),

    // Match metadata
    matchedBy: varchar("matched_by", { length: 20 }), // 'purl', 'cpe', 'name_version'
    // 'direct' — the component's own identity matched the advisory.
    // 'indirect' — it matched via the source package named by its `upstream=` qualifier.
    // Recorded so the upstream path, which now does materially more work, can be
    // measured rather than assumed to help.
    matchType: varchar("match_type", { length: 10 }),
    // 'exact'       — versions compared under a real comparator for the ecosystem.
    // 'fuzzy'       — a comparison had to guess (see matching/version/fuzzy.ts).
    // 'unconfirmed' — the package matched but no version verdict was reachable.
    matchConfidence: varchar("match_confidence", { length: 20 }),

    // ===== Provenance: what the matcher actually matched against =====
    //
    // The matcher already knows all four of these at the moment it decides a
    // match; before these columns existed they were computed and thrown away,
    // and the read paths re-derived the fixed version with a name-based join
    // over vulnerability_affected_packages. That join is a different question
    // from the one the matcher asked — it cannot tell which of an advisory's
    // affected[] entries won, so on a package whose entries disagree it can
    // report a fixed version from a row the matcher rejected. These columns are
    // the answer from the pass that actually matched.

    // fixed_version of the affected[] entry that matched. Null when the
    // advisory states no fix (still open, or expressed only as last_affected).
    fixedVersion: varchar("fixed_version", { length: 255 }),

    // The source package that carried the match, set only when match_type is
    // 'indirect'. An apk libcrypto3 finding inherited from openssl says so here
    // rather than leaving the user to wonder why an advisory for a package they
    // do not have is attached to one they do. The version is the one the range
    // check actually used: distro advisories are written against source
    // versions, so a binary 2.4.1-1ubuntu2 built from source 2.4.1-1 was
    // compared as 2.4.1-1, and recording the binary version here would
    // misrepresent the comparison.
    upstreamName: varchar("upstream_name", { length: 512 }),
    upstreamVersion: varchar("upstream_version", { length: 255 }),

    // Full OSV ecosystem string of the winning entry ('Alpine:v3.23', 'npm').
    // Purely diagnostic: it is what answers "why did this match", and it is the
    // first thing to look at when release scoping is suspected of leaking.
    matchedEcosystem: varchar("matched_ecosystem", { length: 100 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ columns: [table.componentId, table.vulnerabilityId] }),
    foreignKey({
        name: "comp_vuln_component_fk",
        columns: [table.componentId],
        foreignColumns: [components.id],
    }).onDelete("cascade"),
    // RESTRICT, not CASCADE: a vulnerability row is synced upstream data, but
    // deleting one must never silently cascade away a customer's match rows.
    // The component-side FK below stays CASCADE (deleting a customer component
    // should clean up its matches). A stray DELETE on `vulnerabilities` will
    // now error instead of destroying customer data. See ADR-0003.
    foreignKey({
        name: "comp_vuln_vuln_fk",
        columns: [table.vulnerabilityId],
        foreignColumns: [vulnerabilities.id],
    }).onDelete("restrict"),
    // Reverse lookup: PK covers (componentId, vulnerabilityId) but not the other direction
    index("comp_vuln_vuln_id_idx").on(table.vulnerabilityId),
]);

/**
 * Track sync status per vulnerability source.
 *
 * `source` is the natural key (one row per source: 'osv', 'nvd', etc.) and
 * also the primary key — there is no incoming FK that needs a surrogate
 * `uuid`. See docs/db-audit/P3-polish.md § P3-11.
 */
export const vulnerabilitySyncStatus = pgTable("vulnerability_sync_status", {
    source: varchar("source", { length: 50 }).primaryKey(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    cursor: varchar("cursor", { length: 255 }), // For incremental syncs (e.g., modified timestamp)
    status: varchar("status", { length: 20 }).notNull().default("pending"), // 'pending', 'syncing', 'success', 'error'
    errorMessage: text("error_message"),
    vulnCount: integer("vuln_count").default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ===== Inferred Types =====

export type Vulnerability = typeof vulnerabilities.$inferSelect;
export type NewVulnerability = typeof vulnerabilities.$inferInsert;

export type VulnerabilityAffectedPackage = typeof vulnerabilityAffectedPackages.$inferSelect;
export type NewVulnerabilityAffectedPackage = typeof vulnerabilityAffectedPackages.$inferInsert;

export type NewComponentVulnerability = typeof componentVulnerabilities.$inferInsert;

export type VulnerabilitySyncStatus = typeof vulnerabilitySyncStatus.$inferSelect;

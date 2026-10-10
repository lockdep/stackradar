import { pgTable, uuid, varchar, text, timestamp, jsonb, index, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { clusters } from "./clusters.js";
import { images } from "./images.js";
import { helmReleases } from "./helm-releases.js";

/**
 * The remediation workflow's three tables —
 * [remediation-workflow.md](../../../../docs/proposals/remediation-workflow.md)
 * phases 4 and 5, renamed and widened by
 * [issues-workflow.md](../../../../docs/proposals/issues-workflow.md).
 *
 * An **issue** is a tracked commitment against a subject: an image move, a
 * release move, or a finding identity. A suggestion is a computed claim and is
 * never stored; an issue is what the user creates *from* one when they decide
 * to act or to watch. The title is always derived from the subject — `notes`
 * is the only freeform field — because an issue that cannot name its subject
 * is one the verify sweeps can never close, and the sweep is the product
 * claim.
 */

export const ISSUE_SCOPES = ["image", "release", "finding"] as const;
export type IssueScope = (typeof ISSUE_SCOPES)[number];

/**
 * The lifecycle: `open → snoozed(until) → applied → verified`, plus the
 * manual exit `closed`.
 *
 * `verified` is written only by the system — the next inventory report shows
 * the vulnerable digest no longer running, or the next scan shows the finding
 * identity no longer counted — never by the user. That closing loop is the
 * product claim, so a self-asserted "verified" would be a lie the schema
 * invites. `closed` is the user's exit — "fixed it another way", "decided not
 * to", "no longer relevant" — with a mandatory reason, because without it
 * snooze is the only honest way out, which is a different lie. Both are
 * terminal.
 */
export const ISSUE_STATES = ["open", "snoozed", "applied", "verified", "closed"] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/** Why the user closed the issue themselves. Enum so closures report later. */
export const ISSUE_CLOSED_REASONS = ["fixed-otherwise", "wont-fix", "no-longer-relevant"] as const;
export type IssueClosedReason = (typeof ISSUE_CLOSED_REASONS)[number];

/**
 * A tracked commitment and where it is in its lifecycle.
 *
 * The image and release references are `SET NULL`, with the facts that name
 * the issue (repository, digests, tags, chart versions, the finding key)
 * **denormalised as text**: a terminal issue is history, and history must
 * survive the image GC reclaiming the old digest's row — an issue whose
 * subject line disappears a month later is a record nobody can read.
 *
 * `createdByUserId` is a bare column, not an FK: the auth identity lives in
 * the client database (Auth.js), and the server-side `users` mirror is only
 * guaranteed a row after flows that call `ensureUserExists`. The id is stored
 * for attribution alongside the email that was on the request. `closedBy*`
 * follows the same pattern.
 *
 * No risk score is stored anywhere on this table — the Issues list folds the
 * counted findings in each issue's scope at read time (ADR 0005). EPSS syncs
 * daily; a stored score is a stale score.
 */
export const issues = pgTable("issues", {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * The cluster whose next inventory report can verify this issue. Null for
     * `finding` scope: a finding identity is org-wide by construction, so the
     * scan sweep — not any one cluster's report — is what closes it.
     */
    clusterId: uuid("cluster_id"),

    scope: varchar("scope", { length: 10 }).notNull().$type<IssueScope>(),

    imageId: uuid("image_id").references(() => images.id, { onDelete: "set null" }),
    releaseId: uuid("release_id").references(() => helmReleases.id, { onDelete: "set null" }),

    /* Image scope: what moves. `to*` may be null when the issue was opened
       without a measured candidate (the user chose the target themselves). */
    repository: varchar("repository", { length: 512 }),
    fromDigest: varchar("from_digest", { length: 128 }),
    fromTag: varchar("from_tag", { length: 255 }),
    toDigest: varchar("to_digest", { length: 128 }),
    toTag: varchar("to_tag", { length: 255 }),

    /* Release scope: the chart bump that subsumes the image moves. */
    chartName: varchar("chart_name", { length: 253 }),
    fromChartVersion: varchar("from_chart_version", { length: 128 }),
    toChartVersion: varchar("to_chart_version", { length: 128 }),

    /* Finding scope: the cross-image finding identity — the same key
       `finding_states` suppresses on and `finding-delta.ts` diffs on,
       resolved by the service at write time. `vulnId` is the advisory id the
       user acted on, for display. */
    packageType: varchar("package_type", { length: 50 }),
    packageName: varchar("package_name", { length: 512 }),
    vulnIdentity: varchar("vuln_identity", { length: 255 }),
    vulnId: varchar("vuln_id", { length: 255 }),

    state: varchar("state", { length: 20 }).notNull().default("open").$type<IssueState>(),
    /** Only meaningful in `snoozed`; a past date reads as `open` again. */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    /* The manual exit. Reason mandatory when closed; note optional. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: varchar("closed_reason", { length: 30 }).$type<IssueClosedReason>(),
    closedNote: text("closed_note"),
    closedByUserId: varchar("closed_by_user_id", { length: 64 }),
    closedByEmail: varchar("closed_by_email", { length: 255 }),

    createdByUserId: varchar("created_by_user_id", { length: 64 }),
    createdByEmail: varchar("created_by_email", { length: 255 }),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    /** The Issues tab's list and the verify sweeps both read by org/cluster + state. */
    index("issues_org_state_idx").on(table.orgId, table.state),
    index("issues_cluster_state_idx").on(table.clusterId, table.state),
    index("issues_image_id_idx").on(table.imageId),
    /** Covers the SET NULL sweep when a helm_releases row is deleted. */
    index("issues_release_id_idx").on(table.releaseId),
    /** The `fix.available` consumer looks open finding issues up by identity. */
    index("issues_vuln_identity_idx").on(table.vulnIdentity),
    /** An issue cannot point at another org's cluster. */
    foreignKey({
        columns: [table.clusterId, table.orgId],
        foreignColumns: [clusters.id, clusters.orgId],
        name: "issues_cluster_id_org_id_fk",
    }).onDelete("cascade"),
    /** Each scope names its subject even after the FK is nulled. */
    check(
        "issues_scope_subject_check",
        sql`(${table.scope} = 'image' AND ${table.fromDigest} IS NOT NULL)
         OR (${table.scope} = 'release' AND ${table.chartName} IS NOT NULL)
         OR (${table.scope} = 'finding' AND ${table.packageType} IS NOT NULL
             AND ${table.packageName} IS NOT NULL AND ${table.vulnIdentity} IS NOT NULL)`
    ),
    /** A closed issue must say why; only a closed issue may. */
    check(
        "issues_closed_reason_check",
        sql`(${table.state} = 'closed') = (${table.closedReason} IS NOT NULL)`
    ),
]);

export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;

export const FINDING_STATE_KINDS = ["suppressed", "accepted-risk"] as const;
export type FindingStateKind = (typeof FINDING_STATE_KINDS)[number];

/**
 * Suppress / accept-risk on a finding — with an owner, a reason and an
 * **expiry**, all mandatory. Without the expiry the issue list never reaches
 * zero honestly, and a list that never reaches zero stops being opened.
 * Suppression is never automatic — that is how scanners lose trust — so
 * nothing in the worker writes here.
 *
 * Suppression and finding issues are opposites, and both stay: a suppression
 * says *stop showing me this*; a finding issue says *keep me informed about
 * this until it moves*. Neither replaces the other.
 *
 * ## The key
 *
 * The proposal keyed this on `(project, vulnId, componentPurl)`; `projects`
 * is gone and a PURL carries the version, which would silently un-suppress a
 * finding on every image bump. The key used instead is the **cross-image
 * finding identity** from `finding-delta.ts` — `(packageType, packageName,
 * vulnIdentity)` scoped to the org — so a suppression follows the finding
 * across digests exactly as the delta diff does, and expires on schedule
 * rather than by accident.
 *
 * `vulnIdentity` is the collapsed identity `db/findings.ts#findingIdentity`
 * computes (the CVE when there is exactly one, `#<vulnId>` otherwise),
 * resolved by the service at write time so the join at read time is a plain
 * column match.
 */
export const findingStates = pgTable("finding_states", {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

    kind: varchar("kind", { length: 20 }).notNull().$type<FindingStateKind>(),

    packageType: varchar("package_type", { length: 50 }).notNull(),
    packageName: varchar("package_name", { length: 512 }).notNull(),
    vulnIdentity: varchar("vuln_identity", { length: 255 }).notNull(),
    /** The advisory id the user acted on, for display (`GHSA-…`, `CVE-…`). */
    vulnId: varchar("vuln_id", { length: 255 }).notNull(),

    /** Attribution — same non-FK reasoning as `issues`. */
    createdByUserId: varchar("created_by_user_id", { length: 64 }).notNull(),
    createdByEmail: varchar("created_by_email", { length: 255 }).notNull(),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("finding_states_org_finding_unique")
        .on(table.orgId, table.packageType, table.packageName, table.vulnIdentity),
]);

export type FindingState = typeof findingStates.$inferSelect;
export type NewFindingState = typeof findingStates.$inferInsert;

/**
 * The feed carries **changes, not inventory** — a new critical in something
 * running, an issue verified, a suppression placed. Never one entry per
 * finding per scan: a single base image bump must be one event, not three
 * hundred, or the feed recreates the noise problem the ranking work exists
 * to fight.
 */
export const ACTIVITY_EVENT_TYPES = [
    "issue.created",
    "issue.snoozed",
    "issue.applied",
    "issue.reopened",
    "issue.verified",
    "issue.closed",
    "issue.fix-available",
    "finding.suppressed",
    "finding.unsuppressed",
    "scan.criticals-increased",
    /*
     * The activity feed's own types — activity-feed.md §6. Written by the
     * inventory report (container.*) and by the scan job
     * (scan.findings-changed), one event per change, never one per finding:
     * a scan's added and removed findings ride in one payload.
     *
     * `container.retagged` is its own type because it is the case where the
     * running bytes did **not** change — the same digest under a new tag —
     * and the reader must not mistake it for a deploy.
     */
    "container.appeared",
    "container.removed",
    "container.image-changed",
    "container.rollout-started",
    "container.retagged",
    "scan.findings-changed",
    /*
     * CISA added an advisory to the KEV catalogue while an image carrying it
     * was running (`services/kev-listing.service.ts`). One event per (org,
     * advisory), the affected images in the payload — the change is the
     * listing, not the findings, which were already there. Not a Feed type:
     * the alert worker is its reader, and the weekly digest's "new on KEV"
     * line counts it.
     */
    "finding.kev-listed",
    /*
     * Audit trail of an org saying who controls an image repository
     * (`image_control_rules`): set, changed, or reset to detected. Not a Feed
     * type — `FEED_EVENT_TYPES` lists what the Feed shows.
     */
    "image.control-set",
    /* An org added or removed a component tier rule (`component_tier_rules`). */
    "tier-rule.created",
    "tier-rule.removed",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/**
 * Append-only change log, read by the Fix tab's Activity feed, the issue
 * detail's lifecycle timeline, and — when
 * [notifications.md](../../../../docs/proposals/notifications.md) is built —
 * by the outbound delivery worker. Build the event table once, let all of
 * them read it; that is why the payload is jsonb rather than columns per
 * type.
 */
export const activityEvents = pgTable("activity_events", {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").references(() => clusters.id, { onDelete: "cascade" }),

    type: varchar("type", { length: 50 }).notNull().$type<ActivityEventType>(),

    /** Subjects, nulled rather than lost when the row they point at goes. */
    imageId: uuid("image_id").references(() => images.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),

    /** Everything the feed line needs to render without a join. */
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("activity_events_org_created_idx").on(table.orgId, table.createdAt),
    /** The issue detail's timeline reads by issue. */
    index("activity_events_issue_id_idx").on(table.issueId),
    /** Covers the SET NULL sweep on image deletion (image GC is high-frequency). */
    index("activity_events_image_id_idx").on(table.imageId),
    /** Covers the CASCADE from clusters on cluster deletion. */
    index("activity_events_cluster_id_idx").on(table.clusterId),
]);

export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;

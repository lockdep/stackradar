import { pgTable, uuid, varchar, boolean, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Plan types for subscription tiers. `community` is the community
 * edition's one plan (`config/plans.ts`): stored by the default organisation
 * a community install creates, never sold, and never read on the cloud.
 */
export type PlanType = "free" | "pro" | "team" | "community";

/**
 * Available organization colors
 */
export const ORG_COLORS = [
    "emerald",
    "blue", 
    "purple",
    "orange",
    "pink",
    "cyan",
    "indigo",
    "rose",
] as const;

export type OrgColor = typeof ORG_COLORS[number];

/**
 * Organizations table
 * Represents a team/company that owns projects and has a subscription
 */
export const organizations = pgTable("organizations", {
    id: uuid("id").primaryKey().defaultRandom(),
    
    // Basic info
    name: varchar("name", { length: 255 }).notNull(),
    // Slug uniqueness is enforced case-insensitively via the partial
    // functional index below so that:
    //   1. Soft-deleted orgs free up their slug for reuse.
    //   2. `Acme` and `acme` cannot coexist as separate active orgs (slugs
    //      are URL-visible — case-collisions are hostile UX).
    //   3. Lookup queries that filter by `deleted_at IS NULL` can use an
    //      index that already encodes that predicate.
    // See docs/db-audit/P1-missing-indexes.md § P1-9 and
    // docs/db-audit/P3-polish.md § P3-2.
    slug: varchar("slug", { length: 255 }).notNull(),
    color: varchar("color", { length: 50 }).$type<OrgColor>(),
    
    // Subscription
    plan: varchar("plan", { length: 50 }).notNull().default("free").$type<PlanType>(),

    /**
     * The StackRadar-owned platform organization —
     * [measuring-candidate-charts.md](../../../../docs/proposals/measuring-candidate-charts.md)
     * phase 3. Exactly one row is expected to carry `true`
     * (`platform.service.ts` seeds it). The platform scanner writes candidate
     * SBOMs under it; sharing those rows requires trusting no tenant, which is
     * the shape ADR 0006 named as the only compatible one. No member may join
     * a system org and no API key may be minted for it — both enforced in
     * code, not convention.
     */
    system: boolean("system").notNull().default(false),

    /**
     * The public **demo organisation** — `docs/live-demo/` step 01. Set only
     * by the seed script (`scripts/seed-demo.ts`); no request path can flip
     * it. What it means: every internal (BFF) request scoped to this org is
     * **read-only** — `requireOrg` refuses non-read methods with
     * `403 read_only_demo` — and the org is excluded from platform metrics
     * and billing nags. API-key ingest into its cluster is unaffected, so the
     * demo reporter keeps the picture fresh. Nobody may be added as a member
     * except by the seed (`addOrgMember` refuses). Enforced in
     * `middleware/auth.ts` and `organization.repository.ts`, not by convention.
     */
    demo: boolean("demo").notNull().default(false),

    /**
     * Whether the Monday weekly digest email goes to this org's owners and
     * admins (`services/digest.service.ts`). On by default — it is the
     * product's only push channel — and switched off by the settings toggle
     * or the unsubscribe link in the mail itself (a signed token, so the
     * link needs no session). Demo and system orgs are excluded regardless.
     */
    weeklyDigestEnabled: boolean("weekly_digest_enabled").notNull().default(true),

    /**
     * Critical & KEV alerts (`services/alert.service.ts`, strategy doc
     * 2026-09-26 §3 P3): a message within minutes when an advisory the
     * mirror just learned about lands as a critical or CISA-KEV finding on an
     * image the org is running, or when CISA lists something already
     * running. Two channels, independent: email to owners and admins, and a
     * Slack incoming webhook. Both are inert on the free plan — the worker
     * checks `PLAN_LIMITS[plan].alerts` on every pass, so a downgrade
     * silences them without touching these columns and an upgrade turns the
     * email channel on with nothing to configure.
     *
     * `alertsCursorAt` is the delivery watermark: events up to it have been
     * offered for alerting. Null until the first pass sees the org eligible,
     * which then starts it at "now" — an org that upgrades is not sent the
     * month of events that predate its paying.
     */
    alertEmailEnabled: boolean("alert_email_enabled").notNull().default(true),
    alertSlackWebhookUrl: text("alert_slack_webhook_url"),
    /**
     * What is worth an alert (`lib/alert-batch.ts` `AlertCriteria`):
     * findings at or above this severity — `critical` (default), `high`, or
     * `none` for no severity rule — and, independently, anything on CISA
     * KEV whatever its severity. Both off is refused at the API; that is
     * what the email toggle is for.
     */
    alertMinSeverity: varchar("alert_min_severity", { length: 16 })
        .notNull()
        .default("critical")
        .$type<"critical" | "high" | "none">(),
    alertKev: boolean("alert_kev").notNull().default(true),
    alertsCursorAt: timestamp("alerts_cursor_at", { withTimezone: true }),

    /**
     * The findings view this org's tables open on, and the one the weekly
     * digest's "Start here" rows are drawn with: `application` (the default —
     * packages the build added) or `all`. A reader's own last choice and a
     * link's `?tier=` still beat it; this is the fallback. Not suppression.
     */
    defaultFindingTier: varchar("default_finding_tier", { length: 16 })
        .notNull()
        .default("application")
        .$type<"application" | "all">(),

    // Stripe integration (for paid plans)
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    stripeSubscriptionStatus: varchar("stripe_subscription_status", { length: 50 }),
    stripeCurrentPeriodEnd: timestamp("stripe_current_period_end", { withTimezone: true }),
    stripeCancelAt: timestamp("stripe_cancel_at", { withTimezone: true }),
    
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    
    // Soft delete
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
    uniqueIndex("organizations_slug_active_unique")
        .on(sql`LOWER(${table.slug})`)
        .where(sql`${table.deletedAt} IS NULL`),
]);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;


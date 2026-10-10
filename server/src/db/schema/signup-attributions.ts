import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { organizations } from "./organizations.js";

/**
 * Which ad click, if any, brought a self-signed-up user here.
 *
 * One row per self-signed-up user, written once at `POST /users/setup`
 * from the query parameters the marketing site forwarded onto the login
 * link (the client's `lib/attribution.ts` carries them through the OAuth
 * round trip in a one-hour cookie). An organic sign-up whose login URL
 * carried nothing still gets a row, with every column null: the row is
 * also the "this org was founded by a self-sign-up" marker the analytics
 * events below key on. Users who arrive by invitation never pass through
 * setup and have no row.
 *
 * The row is the source for two pairs of events
 * (`services/attribution.service.ts`), each fired at the same two moments:
 * "signed up" at setup and "connected a cluster" the first time the org's
 * scanner reports an inventory. One pair goes back to the ad network the
 * click came from (only when there is a click id); the other goes to
 * PostHog as `signup_completed` / `first_sbom_received` for every row, so
 * the funnel counts organic sign-ups too. Each `*_sent_at` is stamped when
 * its receiver accepted the event, so a retry can never double-report and
 * the inventory hook can find its candidates with one indexed read.
 *
 * `click_id` is the network's own opaque click identifier (Reddit's
 * `rdt_cid` today). It is the only value ever sent back — no email, IP or
 * user agent — which is what the privacy policy's "ad click attribution"
 * paragraph promises. The `utm_*` columns are kept for our own reporting
 * (which campaign and creative the sign-up came from) and never leave.
 *
 * `timezone` and `locale` are the browser's IANA time zone and its first
 * `Accept-Language` tag at sign-up — the cheapest honest answer to "where
 * is this person", without an IP lookup or a GeoIP database. They go to
 * PostHog as event properties and into the founder alert; the privacy
 * policy's account-data section lists them.
 *
 * The row also drives a third receiver: the founder alert
 * (`services/founder-alert.service.ts`) — an email and/or Slack message to
 * the operator at the same two moments, so a real sign-up gets a personal
 * reply within a day. Its `founder_*_alert_sent_at` stamps work like the
 * other two pairs.
 */
export const signupAttributions = pgTable("signup_attributions", {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    clickId: varchar("click_id", { length: 255 }),
    utmSource: varchar("utm_source", { length: 255 }),
    utmMedium: varchar("utm_medium", { length: 255 }),
    utmCampaign: varchar("utm_campaign", { length: 255 }),
    utmContent: varchar("utm_content", { length: 255 }),
    utmTerm: varchar("utm_term", { length: 255 }),
    timezone: varchar("timezone", { length: 64 }),
    locale: varchar("locale", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Ad-network conversion stamps (Reddit today). Only rows with a click id
    // ever get these.
    signupEventSentAt: timestamp("signup_event_sent_at", { withTimezone: true }),
    clusterEventSentAt: timestamp("cluster_event_sent_at", { withTimezone: true }),
    // PostHog funnel-event stamps. Every row gets these.
    analyticsSignupSentAt: timestamp("analytics_signup_sent_at", { withTimezone: true }),
    analyticsClusterSentAt: timestamp("analytics_cluster_sent_at", { withTimezone: true }),
    // Founder-alert stamps. Every row gets these.
    founderSignupAlertSentAt: timestamp("founder_signup_alert_sent_at", { withTimezone: true }),
    founderClusterAlertSentAt: timestamp("founder_cluster_alert_sent_at", { withTimezone: true }),
}, (table) => [
    // The inventory hook asks "does this org still owe a cluster event?" on
    // every report; the org index keeps that a point lookup.
    index("signup_attributions_org_id_idx").on(table.orgId),
]);

export type SignupAttribution = typeof signupAttributions.$inferSelect;
export type NewSignupAttribution = typeof signupAttributions.$inferInsert;

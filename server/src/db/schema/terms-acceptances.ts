import { pgTable, uuid, varchar, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { organizations } from "./organizations.js";
import type { OrgRole } from "./org-members.js";

/**
 * Append-only record of which version of the Terms of Service each user
 * accepted, and when. This table is evidence, not state: in a dispute the
 * question is "did this person agree to *that* version at *that* time", so
 * rows are only ever inserted — never updated or deleted by application code.
 * The user's current standing is derived (latest row vs
 * `CURRENT_TERMS_VERSION` in `config/terms.ts`).
 *
 * A version is the ISO date of the terms' effective date (e.g. "2026-08-20"),
 * kept in lockstep with the marketing site's `legal.ts`, which renders the
 * document itself.
 */
export const termsAcceptances = pgTable(
    "terms_acceptances",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        termsVersion: varchar("terms_version", { length: 32 }).notNull(),
        acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // One row per user per version: re-accepting the same version is a no-op
        // (`onConflictDoNothing`), so the recorded timestamp is always the first
        // acceptance of that version.
        uniqueIndex("terms_acceptances_user_version_unique").on(table.userId, table.termsVersion),
    ],
);

export type TermsAcceptance = typeof termsAcceptances.$inferSelect;
export type NewTermsAcceptance = typeof termsAcceptances.$inferInsert;

/**
 * Append-only record of a terms version being accepted *on behalf of an
 * organisation* — the org is the contract counterparty (terms § 1), and this
 * table is what shows someone bound it to a specific version, in what role,
 * at what time. The user-level table above still records every individual's
 * own acceptance; this one exists because memberships change and ownership
 * transfers, so a join through `org_members` cannot reconstruct who had which
 * role at the moment of acceptance.
 *
 * For now **any member's acceptance binds the org** — the write sites don't
 * filter by role. When that tightens to admin/owner-only it is a call-site
 * change; `accepted_by_role` is what keeps rows written under today's rule
 * interpretable after the rule changes.
 */
export const orgTermsAcceptances = pgTable(
    "org_terms_acceptances",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        // SET NULL, not cascade: the org's evidence must survive the accepting
        // user erasing their account. Role and timestamp remain; only the
        // identity link is severed, which is what account erasure asks for.
        acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
        acceptedByRole: varchar("accepted_by_role", { length: 50 }).notNull().$type<OrgRole>(),
        termsVersion: varchar("terms_version", { length: 32 }).notNull(),
        acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // One row per org per version: the first acceptance binds the org and
        // later members re-accepting the same version are no-ops.
        uniqueIndex("org_terms_acceptances_org_version_unique").on(table.orgId, table.termsVersion),
        // Covers the FK's SET NULL on user erasure.
        index("org_terms_acceptances_accepted_by_user_id_idx").on(table.acceptedByUserId),
    ],
);

export type OrgTermsAcceptance = typeof orgTermsAcceptances.$inferSelect;
export type NewOrgTermsAcceptance = typeof orgTermsAcceptances.$inferInsert;

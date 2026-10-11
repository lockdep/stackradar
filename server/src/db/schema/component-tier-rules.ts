import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import type { AssignableTier, TierRuleKind } from "../../lib/component-tier.js";

/**
 * An org's override of the built-in component classifier
 * (`lib/component-tier.ts`): "everything under `pkg:npm/@mycorp/` is our
 * application". Applied after the built-in rules at ingest and by every
 * reclassification; a change queues a `tier_reclassify` job for that org
 * only, and is an audited `tier-rule.*` activity event.
 *
 * It moves a component between the findings lens's buckets. It is not
 * suppression: nothing here hides, excludes or un-counts a finding.
 */
export const componentTierRules = pgTable(
    "component_tier_rules",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        matchKind: varchar("match_kind", { length: 16 }).notNull().$type<TierRuleKind>(),
        /** A literal prefix, or for `name` the whole package name. No wildcards. */
        pattern: text("pattern").notNull(),
        tier: varchar("tier", { length: 16 }).notNull().$type<AssignableTier>(),
        createdBy: uuid("created_by"),
        createdByEmail: varchar("created_by_email", { length: 320 }),
        reason: text("reason"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("component_tier_rules_org_kind_pattern_unique").on(table.orgId, table.matchKind, table.pattern),
    ],
);

export type ComponentTierRule = typeof componentTierRules.$inferSelect;
export type NewComponentTierRule = typeof componentTierRules.$inferInsert;

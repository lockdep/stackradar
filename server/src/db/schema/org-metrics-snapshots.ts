import { pgTable, uuid, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import type { SnapshotBreakdown } from "../../lib/snapshot-breakdown.js";
import { organizations } from "./organizations.js";

export const orgMetricsSnapshots = pgTable(
    "org_metrics_snapshots",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
        totalVulnerabilities: integer("total_vulnerabilities").notNull(),
        totalWorkloads: integer("total_workloads").notNull(),
        totalComponents: integer("total_components").notNull(),
        /**
         * The org's total risk at capture time — the ADR 0007 unbounded sum
         * `orgRiskRollup` folds, rounded to a whole number because the magnitude
         * is what the trend shows and every surface already rounds it for
         * display. Defaulted so rows captured before the column existed read as
         * 0 rather than blocking the migration.
         */
        riskScore: integer("risk_score").notNull().default(0),
        criticalVulnerabilities: integer("critical_vulnerabilities").notNull().default(0),
        highVulnerabilities: integer("high_vulnerabilities").notNull().default(0),
        mediumVulnerabilities: integer("medium_vulnerabilities").notNull().default(0),
        lowVulnerabilities: integer("low_vulnerabilities").notNull().default(0),
        /**
         * The same counts split by whose image and by findings lens bucket — what
         * a filtered trend sums (`lib/snapshot-breakdown.ts`). Null on rows
         * captured before it was recorded; a filtered series leaves those out.
         */
        breakdown: jsonb("breakdown").$type<SnapshotBreakdown>(),
    },
    (table) => [index("org_metrics_snapshots_org_id_captured_at_idx").on(table.orgId, table.capturedAt)],
);

export type OrgMetricsSnapshot = typeof orgMetricsSnapshots.$inferSelect;
export type NewOrgMetricsSnapshot = typeof orgMetricsSnapshots.$inferInsert;

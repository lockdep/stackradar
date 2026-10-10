import { pgTable, uuid, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { sboms } from "./sboms.js";
import { components } from "./components.js";

/**
 * Stores the dependency relationships between components within an SBOM.
 * 
 * - parentComponentId: The component that HAS the dependency
 * - childComponentId: The component that IS the dependency
 * 
 * Example: If "express" depends on "body-parser", then:
 *   parentComponentId = express.id
 *   childComponentId = body-parser.id
 */
export const componentDependencies = pgTable("component_dependencies", {
    sbomId: uuid("sbom_id").notNull().references(() => sboms.id, { onDelete: "cascade" }),
    parentComponentId: uuid("parent_component_id").notNull().references(() => components.id, { onDelete: "cascade" }),
    childComponentId: uuid("child_component_id").notNull().references(() => components.id, { onDelete: "cascade" }),
    // Timestamp lets us distinguish edges produced by different scanner
    // runs (e.g. after re-running syft with a different flag set) when
    // debugging matcher edge cases. See docs/db-audit/P3-polish.md § P3-6.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ name: "comp_dep_pk", columns: [table.sbomId, table.parentComponentId, table.childComponentId] }),
    // Required to make FK cascades from components (parent_component_id / child_component_id) use an
    // index lookup instead of a sequential scan. The PK is led by sbom_id so it does not cover these.
    index("comp_dep_parent_component_id_idx").on(table.parentComponentId),
    index("comp_dep_child_component_id_idx").on(table.childComponentId),
]);

export type ComponentDependency = typeof componentDependencies.$inferSelect;
export type NewComponentDependency = typeof componentDependencies.$inferInsert;

import { pgTable, uuid, varchar, primaryKey, index } from "drizzle-orm/pg-core";
import { components } from "./components.js";

export const licenses = pgTable("licenses", {
    id: uuid("id").primaryKey().defaultRandom(),
    spdxId: varchar("spdx_id", { length: 100 }).unique(),
    name: varchar("name", { length: 255 }),
    expression: varchar("expression", { length: 512 }),
});

export const componentLicenses = pgTable(
    "component_licenses",
    {
        componentId: uuid("component_id")
            .notNull()
            .references(() => components.id, { onDelete: "cascade" }),
        licenseId: uuid("license_id")
            .notNull()
            .references(() => licenses.id, { onDelete: "cascade" }),
    },
    (table) => [
        primaryKey({ columns: [table.componentId, table.licenseId] }),
        // The primary key leads with component_id; this covers the license FK's cascade.
        index("component_licenses_license_id_idx").on(table.licenseId),
    ],
);

export type License = typeof licenses.$inferSelect;
export type NewLicense = typeof licenses.$inferInsert;

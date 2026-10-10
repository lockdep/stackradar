import { pgTable, uuid, varchar, text, index } from "drizzle-orm/pg-core";
import { components } from "./components.js";

export const componentProperties = pgTable("component_properties", {
    id: uuid("id").primaryKey().defaultRandom(),
    componentId: uuid("component_id").notNull().references(() => components.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    value: text("value").notNull(),
}, (table) => [
    index("component_properties_component_id_idx").on(table.componentId),
]);

export type NewComponentProperty = typeof componentProperties.$inferInsert;

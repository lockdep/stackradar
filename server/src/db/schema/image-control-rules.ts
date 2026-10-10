import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import type { ImageControl } from "../../lib/image-control.js";

/**
 * An org's own answer to "do you build this image?" — one row per repository
 * (or `prefix/*`) the org has spoken about. Always beats the derived signals
 * in `lib/image-control.ts`. Written by the confirm-once prompt and the Image
 * ownership settings tab; every change is an `image.control-set` activity
 * event. A repository the org never touched has no row: the derived verdict
 * stands, and "reset to detected" is a delete.
 */
export const imageControlRules = pgTable("image_control_rules", {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    /** Null = any registry. Stored normalised (`docker.io`, never `index.docker.io`). */
    registry: varchar("registry", { length: 255 }),
    /** A repository, or a prefix with a trailing `*`. */
    repository: varchar("repository", { length: 512 }).notNull(),
    control: varchar("control", { length: 16 }).notNull().$type<Exclude<ImageControl, "unknown">>(),
    createdBy: uuid("created_by"),
    createdByEmail: varchar("created_by_email", { length: 320 }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    // `coalesce`: a plain unique index treats two NULL registries as distinct.
    uniqueIndex("image_control_rules_org_registry_repository_unique")
        .on(table.orgId, sql`coalesce(${table.registry}, '')`, table.repository),
    // No separate org_id index: the unique index leads with it.
]);

export type ImageControlRule = typeof imageControlRules.$inferSelect;
export type NewImageControlRule = typeof imageControlRules.$inferInsert;

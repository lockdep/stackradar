import { pgTable, uuid, varchar, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { organizations } from "./organizations.js";

/**
 * Role types within an organization
 */
export type OrgRole = "owner" | "admin" | "member";

/**
 * Organization members table
 * Links users to organizations with roles
 * A user can belong to multiple organizations
 */
export const orgMembers = pgTable(
    "org_members",
    {
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        role: varchar("role", { length: 50 }).notNull().default("member").$type<OrgRole>(),

        // Timestamps
        joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.orgId] }),
        // The PK leads with user_id, so `WHERE org_id = ?` (member listings,
        // role updates, removals) cannot use it. Add a
        // secondary index on org_id.
        index("org_members_org_id_idx").on(table.orgId),
    ],
);

export type OrgMember = typeof orgMembers.$inferSelect;

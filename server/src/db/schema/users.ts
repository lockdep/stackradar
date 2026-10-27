import { pgTable, uuid, varchar, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Users table - managed by Auth.js
 * Contains user profile information from OAuth providers
 *
 * Email uniqueness is enforced case-insensitively via a functional unique
 * index on `LOWER(email)`. Emails are case-insensitive per RFC 5321, so a
 * plain unique constraint would let "Foo@example.com" and "foo@example.com"
 * coexist. Repository writes (`ensureUserExists`) and reads
 * (`getUserByEmail`) lowercase the value to match.
 */
export const users = pgTable(
    "users",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        name: varchar("name", { length: 255 }),
        email: varchar("email", { length: 255 }).notNull(),
        emailVerified: timestamp("email_verified", { withTimezone: true }),
        image: text("image"),

        /**
         * The shared **demo visitor** account. Set
         * only by the seed script (`scripts/seed-demo.ts`); never by a request.
         * Every non-read internal request from this user is refused with
         * `403 read_only_demo` in `requireAuth`, which is what covers the routes
         * that have no org context (creating an org, accepting an invite,
         * feedback, terms, profile). The org-level counterpart is
         * `organizations.demo`; both are checked because a demo user could
         * otherwise be invited into a real org, or a real user into the demo org.
         */
        demo: boolean("demo").notNull().default(false),

        /**
         * When a subscription this user checked out first entered Stripe's
         * `trialing` status (cloud only; stamped by the Stripe webhook,
         * `cloud/billing/billing.controller.ts`). One free trial per person:
         * a later checkout by the same user carries no trial period and
         * charges from day one, which closes the "cancel the trial, delete
         * the org, sign up again" loop. Null until then, and forever null in
         * the community edition.
         */
        trialConsumedAt: timestamp("trial_consumed_at", { withTimezone: true }),

        // Timestamps
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [uniqueIndex("users_email_lower_unique").on(sql`LOWER(${table.email})`)],
);

export type User = typeof users.$inferSelect;

import { pgTable, varchar, timestamp, jsonb, primaryKey } from "drizzle-orm/pg-core";

/**
 * What a public base image could be rebuilt on — one row per base ref
 * (`registry`, `repository`, `tag`) some image in the fleet is built on
 * (component tier plan, item 7). Written by the nightly pass in
 * `services/base-upgrade.service.ts`; read when a base-image upgrade is
 * recommended.
 *
 * Two candidates per base, and both are facts about a **public** registry:
 *
 *   - `current_digest` — what the tag points to *now*. A pinned-looking tag
 *     (`node:20-bookworm-slim`) is rebuilt under the same name for months; an
 *     image built on last spring's copy of it clears findings by rebuilding on
 *     today's, with no change to its Dockerfile.
 *   - `newer_tag` / `newer_digest` — the newest tag `lib/image-tags.ts` will
 *     call comparable: same variant string, same number of version
 *     components, preferring the same major.
 *
 * Global and tenant-free, like `known_layer_prefixes`: a row says something
 * about `docker.io/library/node`, never about who builds on it.
 */
export type BaseCheckAvailability = "available" | "up-to-date" | "no-candidates" | "ambiguous-ordering";

export const baseImageChecks = pgTable(
    "base_image_checks",
    {
        registry: varchar("registry", { length: 255 }).notNull(),
        repository: varchar("repository", { length: 512 }).notNull(),
        tag: varchar("tag", { length: 255 }).notNull(),
        /** The digest the tag resolves to today; null when the registry would not say. */
        currentDigest: varchar("current_digest", { length: 128 }),
        /** The tag-axis verdict, in the image-upgrade vocabulary. */
        availability: varchar("availability", { length: 24 }).notNull().$type<BaseCheckAvailability>(),
        newerTag: varchar("newer_tag", { length: 255 }),
        newerDigest: varchar("newer_digest", { length: 128 }),
        /** Tags refused, with the reason — surfaced, never resolved silently. Capped. */
        skipped: jsonb("skipped").$type<Array<{ tag: string; reason: string }>>().notNull().default([]),
        checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.registry, table.repository, table.tag] })],
);

export type BaseImageCheck = typeof baseImageChecks.$inferSelect;
export type NewBaseImageCheck = typeof baseImageChecks.$inferInsert;

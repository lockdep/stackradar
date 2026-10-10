import { pgTable, varchar, text, smallint, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

/**
 * Public images whose whole layer chain we know, keyed by the hash of that
 * chain (`chainHash` in `lib/base-image.ts`) — the lookup behind base-image
 * detection's strongest data-driven signal: "the first *k* layers of this
 * image are exactly the layers of `node:20-bookworm-slim`".
 *
 * **Public images only, and never derived from an upload.** A row is written
 * from a chain the platform fetched itself from a public registry, or that
 * the public chart index sent (`POST /internal/known-images`): `source` says
 * which. A customer's own images never land here — the org's golden bases are
 * found by comparing its images with each other at read time
 * (`lib/base-image.ts`, signal 3) — so nothing about one tenant's cluster can
 * be read out of this table by another (ADR 0006).
 *
 * One row per `(hash, image_ref)`: a tag that moved has several chains, and
 * two tags can share one.
 */
export const knownLayerPrefixes = pgTable("known_layer_prefixes", {
    diffIdPrefixHash: varchar("diff_id_prefix_hash", { length: 64 }).notNull(),
    /** Layers in the chain — all of them, since a row is a whole image. */
    depth: smallint("depth").notNull(),
    /** `node:20-bookworm-slim`, as a reader would type it. */
    imageRef: text("image_ref").notNull(),
    /** `chart-index` · `registry` (fetched to resolve a named base) · `verified-guess` (a `_VERSION` guess a registry confirmed). */
    source: varchar("source", { length: 24 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ columns: [table.diffIdPrefixHash, table.imageRef] }),
    index("known_layer_prefixes_image_ref_idx").on(table.imageRef),
]);

export type KnownLayerPrefix = typeof knownLayerPrefixes.$inferSelect;
export type NewKnownLayerPrefix = typeof knownLayerPrefixes.$inferInsert;

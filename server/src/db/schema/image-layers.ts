import {
    pgTable,
    uuid,
    varchar,
    text,
    boolean,
    smallint,
    bigint,
    timestamp,
    primaryKey,
    index,
} from "drizzle-orm/pg-core";
import { images } from "./images.js";

/**
 * One row per image-history entry, in order — the layers of a digest and the
 * Dockerfile line that made each (component tier plan, item 5).
 *
 * Keyed by **image**, not SBOM: layers are a property of the digest
 * (ADR 0004), so a `?replace=true` re-upload supersedes the SBOM and leaves
 * these alone unless it brings its own. Cluster-scoped through `images`
 * (ADR 0006) like everything else derived from an upload.
 *
 * `index` is the history position and includes the entries that made no layer
 * (`ENV`, `CMD`, `LABEL`): the base-boundary heuristics read them. `diff_id`,
 * `size` and `rootfs_index` are null on those. `rootfs_index` is the position
 * among the layers that exist — what `components.layer_index` refers to.
 *
 * `created_by` arrives redacted and capped by the scanner; the server never
 * sees the raw line. Written by the ingest path from the upload's
 * `stackradar:layer:*` properties, or by the registry backfill for public
 * images scanned before the scanner sent them (`source`).
 */
export const imageLayers = pgTable(
    "image_layers",
    {
        imageId: uuid("image_id")
            .notNull()
            .references(() => images.id, { onDelete: "cascade" }),
        index: smallint("index").notNull(),
        rootfsIndex: smallint("rootfs_index"),
        diffId: varchar("diff_id", { length: 128 }),
        createdBy: text("created_by"),
        emptyLayer: boolean("empty_layer").notNull().default(false),
        size: bigint("size", { mode: "number" }),
        /** The history entry's own timestamp — when the layer was built, not when we saw it. */
        builtAt: timestamp("built_at", { withTimezone: true }),
        /** `scanner` (the upload carried it) or `registry` (the backfill fetched the config blob). */
        source: varchar("source", { length: 16 }).notNull().default("scanner"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        primaryKey({ columns: [table.imageId, table.index] }),
        // The known-prefix lookup of item 6: "which images start with these layers".
        index("image_layers_diff_id_idx").on(table.diffId),
    ],
);

export type ImageLayer = typeof imageLayers.$inferSelect;
export type NewImageLayer = typeof imageLayers.$inferInsert;

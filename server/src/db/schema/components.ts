import { pgTable, uuid, varchar, text, boolean, smallint, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sboms } from "./sboms.js";
import type { Tier } from "../../lib/component-tier.js";

/**
 * Component scope within an SBOM context
 * - required: Dependency is required for functionality
 * - optional: Dependency is optional/dev-only
 * - excluded: Dependency is explicitly excluded
 */
export type ComponentScope = "required" | "optional" | "excluded";

export const components = pgTable(
    "components",
    {
        // uuidv7() (PG18): time-ordered UUIDs so the PK index appends instead of
        // scattering — this is the highest-insert-rate table in the model (every
        // SBOM ingest bulk-inserts its components).
        id: uuid("id")
            .primaryKey()
            .default(sql`uuidv7()`),
        sbomId: uuid("sbom_id")
            .notNull()
            .references(() => sboms.id, { onDelete: "cascade" }),
        // PURL and CPE are unbounded in practice (long Maven GAVs, NuGet IDs,
        // CPE 2.3 URIs with edition extensions). `text` has the same on-disk
        // representation as `varchar(n)` in Postgres but cannot truncate.
        purl: text("purl"),
        // Machine-generated external SBOM data — name, version, publisher, author,
        // group and bom-ref are all unbounded in practice, and an over-long value
        // must not 500 a whole upload. `text` per the schema README convention.
        name: text("name").notNull(),
        version: text("version"),
        type: varchar("type", { length: 50 }).notNull(),
        groupName: text("group_name"),
        publisher: text("publisher"),
        author: text("author"),
        description: text("description"),
        cpe: text("cpe"),
        bomRef: text("bom_ref"),
        isDirect: boolean("is_direct").default(false),
        scope: varchar("scope", { length: 20 }).$type<ComponentScope>(),
        // What kind of thing this occurrence is (os / runtime / application / main
        // / unknown) — a default lens for findings, never a verdict. A column, not
        // a property row, because every findings query already joins `components`
        // and a filter in the unindexed name/value table would undo the db-perf
        // fencing. Written by `lib/component-tier.ts` at ingest; `tier_version`
        // lets the backfill re-classify without a rescan when the rules change.
        tier: varchar("tier", { length: 16 }).$type<Tier>().notNull().default("unknown"),
        tierVersion: smallint("tier_version").notNull().default(0),
        // The earliest layer this component exists in, as an index into the
        // image's layers that exist (`image_layers.rootfs_index`): the minimum
        // over all `syft:location:N:layerID` properties, never location 0 alone
        // (`lib/image-layers.ts` says why). Null when the scanner sent no layer
        // list or no id resolved. For `os`-tier rows it is only trustworthy from
        // scanner 0.4.0 (`--scope deep-squashed`); item 6 gates on that.
        layerIndex: smallint("layer_index"),
        // Whether the component came from the base image's layers:
        // `layer_index < images.base_layer_count`. Null until the boundary is
        // known (`lib/base-image.ts`) — and, for an `os`-tier row, until its
        // layer can be trusted — in which case the tier stands in. When set it
        // decides the lens bucket: an `apt-get install` in the customer's own
        // layer is `os` *and* theirs to fix (`db/finding-tier.ts`).
        fromBase: boolean("from_base"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // Covers cascade deletes from sboms and WHERE sbom_id = ? AND type = 'library' queries
        index("components_sbom_id_type_idx").on(table.sbomId, table.type),
        // Package name lookups in vulnerability matching
        index("components_name_idx").on(table.name),
        // No index on `purl`: matching keys on `vulnerability_affected_packages.match_key`,
        // and the only purl predicate left is the packages search's `ILIKE '%…%'`,
        // which a b-tree cannot serve. No partial (sbom_id, is_direct) index
        // either: nothing filters on `is_direct` any more. Both had zero scans
        // since 2026-08-25 and cost a write per component ingested.
    ],
);

export type Component = typeof components.$inferSelect;
export type NewComponent = typeof components.$inferInsert;

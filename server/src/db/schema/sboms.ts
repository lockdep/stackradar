import { pgTable, uuid, varchar, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { images } from "./images.js";

/**
 * An SBOM belongs to an **image**, not to a workload — and an image is now a
 * digest *as seen by one cluster* (ADR 0006), so the SBOM is scoped to the
 * cluster whose key uploaded it. It can only ever influence findings inside
 * that cluster.
 *
 * `isCurrent` is gone with the `projects` tree it served. A digest is
 * content-addressed, so its component list does not change and there is nothing
 * for currentness to mean; which image is *live* is a property of which digest
 * a `workload_containers` row references.
 *
 * Note what is **not** here: no `imageTag`, no `imageRef`, no `labels`, no
 * namespace. Every one of those is a fact about a deployment and lives on
 * `workload_containers`. `registry` and `repository` describe the bytes and
 * live on `images`; the cluster is `images.clusterId`, which is also what
 * attributes the upload.
 */
export const sboms = pgTable(
    "sboms",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        imageId: uuid("image_id")
            .notNull()
            .references(() => images.id, { onDelete: "cascade" }),

        // SBOM format and deduplication
        format: varchar("format", { length: 20 }).notNull(), // always 'cyclonedx' — the only format we ingest
        sbomSha256: varchar("sbom_sha256", { length: 64 }).notNull(), // SHA-256 hash of raw SBOM for deduplication

        // SBOM document metadata (from the SBOM itself)
        serialNumber: varchar("serial_number", { length: 255 }), // CycloneDX URN UUID, not globally enforced
        documentVersion: integer("document_version"), // SBOM's own version field (nullable, not always present)
        specVersion: varchar("spec_version", { length: 10 }).notNull(), // CycloneDX spec version, e.g. '1.6'

        // Source/tool info (explicit columns for common fields)
        sourceName: varchar("source_name", { length: 255 }),
        sourceType: varchar("source_type", { length: 50 }),

        toolName: varchar("tool_name", { length: 255 }),
        toolVersion: varchar("tool_version", { length: 100 }),

        /**
         * The scanner agent version that uploaded this document, from the
         * `X-Scanner-Version` header. Provenance for the supersede path: "which
         * scanner produced the SBOM we are replacing" is the question a bad-scan
         * incident starts with. `images.clusterId` already attributes the upload
         * to a cluster; this attributes it to a build. Null for uploads from
         * agents that predate the header.
         */
        scannerVersion: varchar("scanner_version", { length: 64 }),

        // SBOM-provided timestamp (informational only, may be missing or inaccurate)
        // Use createdAt for reliable ordering
        generatedAt: timestamp("generated_at", { withTimezone: true }),

        // Raw SBOM content
        rawJson: jsonb("raw_json"),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        /**
         * **One SBOM per image, enforced** — which under ADR 0006 means one SBOM
         * per digest **per cluster**. This is the invariant that replaces
         * `isCurrent`: with exactly one row per image, "the SBOM to count findings
         * from" needs no flag, no `DISTINCT ON` and no tie-breaker, and every
         * counting surface reaches it by the same join. A second upload for a
         * digest this cluster already scanned is a duplicate (409, or a supersede
         * with `?replace=true`), which is what the scanner's `existsByDigest`
         * check exists to avoid making.
         */
        uniqueIndex("sboms_image_id_unique").on(table.imageId),
        // `sbom_sha256` is stored but never queried — the duplicate check is by
        // image (`sboms_image_id_unique`) — so it carries no index.
    ],
);

export type Sbom = typeof sboms.$inferSelect;
export type NewSbom = typeof sboms.$inferInsert;

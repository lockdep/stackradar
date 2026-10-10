import { pgTable, uuid, varchar, text, smallint, timestamp, jsonb, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { clusters } from "./clusters.js";
import type { ControlSignal, ImageControl } from "../../lib/image-control.js";
import type { BaseSignal } from "../../lib/base-image.js";

/**
 * Container images, **as seen by one cluster**.
 *
 * Identity is `(cluster_id, digest)`, not the digest alone — see
 * [ADR 0006](../../../../docs/adr/0006-images-are-cluster-scoped.md), which
 * reverses ADR 0004's "no tenant column" invariant. A digest is still
 * content-addressed, but the SBOM we hold for it is an *uploaded claim* about
 * those bytes, and nothing verifies the claim against the digest it names.
 * Sharing that claim across tenants let any tenant's upload dictate every
 * other tenant's findings for a popular digest (SBOM poisoning), and made
 * `GET /v1/sboms/check` an oracle for "has anyone on this platform scanned X".
 * Scoping the row to the cluster whose key uploaded it makes both impossible
 * rather than detected: every cluster pulls, scans and uploads its own SBOM
 * for every digest it runs, and a compromised cluster key can only corrupt
 * that cluster's data.
 *
 * `orgId` is denormalised from the cluster, same as `namespaces`: it backs the
 * org-scoped read paths without a join, and the composite FK below keeps it
 * from disagreeing with the cluster's org. Tenancy checks are now a column
 * comparison (`db/tenancy.ts`), not an EXISTS probe over deployments.
 *
 * Note what is *not* here: `imageTag`. A tag is what a deployment asked for,
 * not a property of the bytes — one digest may carry many tags, and a
 * digest-pinned deployment has none.
 */
export const images = pgTable("images", {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Deletion stays **explicit** in `delete-helpers.ts` / cluster deletion
     * rather than cascading from here: `workload_containers.imageId` is
     * `ON DELETE RESTRICT`, and a cascade from `clusters` racing the
     * namespace-side cascade into that restrict is exactly the kind of
     * order-dependent failure the explicit helpers exist to avoid.
     */
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "no action" }),
    clusterId: uuid("cluster_id").notNull(),

    /**
     * `sha256:…` — the identity, together with `clusterId`. 71 characters for
     * sha256; the column is wider so a future digest algorithm is not a
     * migration.
     */
    digest: varchar("digest", { length: 128 }).notNull(),

    /**
     * Where the bytes were pulled from. Descriptive only: the same digest can
     * be mirrored to several registries and is still one image, so these never
     * take part in identity.
     */
    registry: varchar("registry", { length: 255 }),
    repository: varchar("repository", { length: 512 }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Last time anything vouched for this digest — an inventory report that
     * mentioned it, or an SBOM upload for it.
     *
     * The counterpart to `first_seen_at`, and the only column that can tell an
     * image still in service from one nothing refers to any more. Reachability
     * cannot: `workload_containers` is a full set replacement per report, so a
     * digest drops to zero containers for the few seconds of a rollout exactly
     * as it does when its cluster is deleted. The GC in
     * `delete-helpers.ts` ages on this instead, which is what keeps a rollout
     * from looking like garbage.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Why the last scan attempt for this digest failed, from the scanner's
     * stderr classification on the inventory report — see
     * `docs/contracts/inventory-v3.md`, "Scan failures are display-only
     * classification". All three are null when nothing is known to be wrong.
     *
     * Written by the inventory path, **cleared only by a successful SBOM
     * upload for the digest** — never by an inventory report, because a
     * restarted scanner reports with an empty failure memory and that absence
     * must not erase a still-true error. `code` is an open set
     * (`registry_auth` | `registry_rate_limited` | `scan_error` today); the
     * UI renders an unknown code as a generic failure, so a newer scanner can
     * add one without a server release. The host is stored so the coverage
     * card can name the registry; raw syft stderr never reaches the server —
     * the schema itself is what enforces that.
     */
    lastScanErrorCode: varchar("last_scan_error_code", { length: 64 }),
    lastScanErrorHost: varchar("last_scan_error_host", { length: 255 }),
    lastScanErrorAt: timestamp("last_scan_error_at", { withTimezone: true }),

    /**
     * Facts about the image itself, from its config and manifest, as the
     * scanner sent them on the SBOM upload (`stackradar:image:*` properties,
     * prefix stripped): `baseName`, `baseDigest`, `source`, `version`,
     * `official`, `entrypoint`, `cmd`, `user`, `architecture`, `env:NODE_VERSION`…
     * A property of the digest, so it lives here and not on `sboms`. Null
     * until a scanner ≥ 0.4.0 uploads the image; the scanner's README is the
     * list of what it may hold, and `createdBy`-style redaction happened
     * before it left the customer's cluster. See `lib/image-layers.ts`.
     */
    metadata: jsonb("metadata").$type<Record<string, string>>(),

    /**
     * Who controls the image: `built` (the org builds it), `third-party`, or
     * `unknown`. Derived from the *repository* by `lib/image-control.ts` and
     * stored so every list can filter on it; `control_detected_by` is the
     * signal that decided, `control_detail` what it saw (a chart name, a
     * registry host) for the confirm prompt's reason text. A label, never a
     * score. Internal words: the UI says "Yours" and "Third-party".
     */
    control: varchar("control", { length: 16 }).notNull().default("unknown").$type<ImageControl>(),
    controlDetectedBy: varchar("control_detected_by", { length: 24 }).$type<ControlSignal>(),
    controlDetail: varchar("control_detail", { length: 255 }),

    /**
     * Where the base image ends (`lib/base-image.ts`). `base_image_ref` names
     * it when something can (`node:20-bookworm-slim`); `base_layer_count` is
     * how many of the image's layers that exist belong to it — what
     * `components.from_base` is cut at; `base_detected_by` is the signal that
     * decided. Either of the first two can be null alone: an image can name
     * its base before anyone has counted its layers, and the history
     * heuristic finds a boundary it cannot name.
     */
    baseImageRef: text("base_image_ref"),
    baseLayerCount: smallint("base_layer_count"),
    baseDetectedBy: varchar("base_detected_by", { length: 16 }).$type<BaseSignal>(),

    /**
     * When the registry backfill last tried to read this image's layers
     * (`services/image-layer-backfill`). Set on every attempt that got an
     * answer — filled, unreachable or no matching platform — so a private or
     * deleted image is asked about monthly, not nightly. Not set on a 429:
     * nothing was learned.
     */
    layersCheckedAt: timestamp("layers_checked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    // The identity, and the index behind `existsByDigest` — the check every
    // scanner runs before pulling an image. One row per digest **per cluster**.
    uniqueIndex("images_cluster_digest_unique").on(table.clusterId, table.digest),
    // Backs `findAllWithStats` and the column tenancy checks in `db/tenancy.ts`.
    index("images_org_id_idx").on(table.orgId),
    // "All images from ghcr.io" for the registry breakdown on the images view.
    index("images_registry_repository_idx").on(table.registry, table.repository),
    // The GC's candidate scan: oldest-seen first, so the sweep reads only the
    // head of the index instead of the whole table.
    index("images_last_seen_at_idx").on(table.lastSeenAt),
    // The containers and images lists filter by `?control=` within an org.
    index("images_org_id_control_idx").on(table.orgId, table.control),
    /**
     * Carries the tenant into the reference: an image cannot point at a
     * cluster belonging to a different org. Same pattern as `namespaces`, but
     * `NO ACTION` instead of cascade — see the `orgId` comment above.
     */
    foreignKey({
        columns: [table.clusterId, table.orgId],
        foreignColumns: [clusters.id, clusters.orgId],
        name: "images_cluster_id_org_id_fk",
    }).onDelete("no action"),
]);

export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;

/**
 * What identifies an image: a digest, in one cluster. `imageRef` — the string
 * the pod spec asked for — is deliberately not part of it and lives on
 * `workload_containers`.
 */
export interface ImageIdentity {
    clusterId: string;
    digest: string;
    registry?: string | null;
    repository?: string | null;
}

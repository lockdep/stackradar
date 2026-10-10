import { pgTable, uuid, varchar, text, timestamp, boolean, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { users } from "./users.js";
import { clusters } from "./clusters.js";

/**
 * API Keys table — scanner credentials.
 *
 * Every key is minted with a cluster (`clusterRepository.createWithApiKey` /
 * `rotateApiKey`) and authenticates that cluster's scanner against the `/v1`
 * ingest surface only; `requireInternal` keeps keys off every management
 * route. `created_by` is audit metadata — the auth middleware deliberately
 * does not resolve it into an acting user.
 */
export const apiKeys = pgTable("api_keys", {
    id: uuid("id").primaryKey().defaultRandom(),
    
    // Ownership
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    // `created_by` is audit metadata, never an acting identity — the auth
    // middleware does not resolve it into a user. RESTRICT, not CASCADE:
    // deleting a user who minted live keys must be refused, because cascading
    // would silently revoke an org's scanner credentials and kill ingestion.
    //
    // Nullable since migration 0026: `null` means the server itself stored
    // the key at start-up from `BOOTSTRAP_CLUSTER_API_KEY` — the community
    // edition's scanner credential (`services/default-org.service.ts`),
    // which exists before any user does. Every request path still writes a
    // user id; only the bootstrap writes null.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    
    // Key details
    name: varchar("name", { length: 255 }).notNull(), // e.g., "GitHub Actions - main repo"
    keyPrefix: varchar("key_prefix", { length: 12 }).notNull(), // First 8 chars for identification: "sk_live_abc..."
    keyHash: varchar("key_hash", { length: 255 }).notNull(), // SHA-256 hash of the full key
    /**
     * The key itself, encrypted under `API_KEY_ENCRYPTION_KEY`
     * (`lib/api-key-vault.ts`), so an admin can be shown it again. Null for
     * keys minted before the vault existed or while it is switched off —
     * those authenticate as ever (that is `key_hash`'s job) but can only be
     * rotated, never revealed.
     */
    keyCiphertext: text("key_ciphertext"),
    /** When an admin last revealed the key through the API; the audit log carries who. */
    lastRevealedAt: timestamp("last_revealed_at", { withTimezone: true }),

    // Cluster scope (optional — if set, key is scoped to a specific cluster)
    clusterId: uuid("cluster_id").references(() => clusters.id, { onDelete: "set null" }),

    // Permissions. Stored as a `text[]` so individual scopes are first-class
    // values: queries like "all keys with sbom:write" become a `?` array
    // operator (indexable with GIN) instead of a `LIKE '%sbom:write%'`
    // substring scan that would also match a future `sbom:write-limited`.
    // See docs/db-audit/P3-polish.md § P3-10.
    scopes: text("scopes").array().notNull().default(sql`ARRAY['sbom:write']::text[]`),
    
    // Status
    isActive: boolean("is_active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // null = never expires
    
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
    // Hot path: validateApiKey runs on every authenticated request. The
    // partial unique index guarantees at most one active record per hash
    // (cryptographically unique already, but enforce it in the DB too) and
    // keeps the index small by excluding revoked keys. `keyPrefix` is kept
    // purely as a display column — it adds no security since it is derivable
    // from the plaintext key. See docs/db-audit/P0-correctness.md § P0-4.
    uniqueIndex("api_keys_key_hash_active_unique")
        .on(table.keyHash)
        .where(sql`${table.isActive} = true`),
    // Admin lookups of revoked keys by hash (e.g. audit logs).
    index("api_keys_key_hash_any_idx").on(table.keyHash),
    // Cluster key rotation/revocation queries
    index("api_keys_cluster_id_idx").on(table.clusterId),
    // Postgres doesn't index the referencing side of an FK: without this, the
    // RESTRICT check on user deletion seq-scans api_keys.
    index("api_keys_created_by_idx").on(table.createdBy),
    // getOrgApiKeys lists all keys for an org ordered by createdAt. The
    // composite covers both the filter and the ORDER BY, avoiding a sort.
    // See docs/db-audit/P1-missing-indexes.md § P1-3.
    index("api_keys_org_id_created_at_idx").on(table.orgId, table.createdAt),
    /**
     * The highest-value constraint of the set, because this row is where the
     * scanner ingest path gets *both* its org and its cluster: `requireAuth`
     * reads them off one `api_keys` row and `scanner.controller` hands them
     * straight to `replaceForCluster(orgId, clusterId, …)`. A key whose cluster
     * belonged to a different org would write one tenant's entire inventory
     * into another's, and nothing forbade such a row existing.
     *
     * `NO ACTION`, not `SET NULL`: the single-column FK on `cluster_id` above
     * keeps that behaviour (a revoked cluster leaves an org-scoped key behind),
     * and a composite `SET NULL` would null `org_id` too, which is `NOT NULL`.
     * `cluster_id` is nullable, and MATCH SIMPLE skips the check when it is
     * null — which is exactly right for an org-scoped key.
     */
    foreignKey({
        columns: [table.clusterId, table.orgId],
        foreignColumns: [clusters.id, clusters.orgId],
        name: "api_keys_cluster_id_org_id_fk",
    }),
]);

export type ApiKey = typeof apiKeys.$inferSelect;


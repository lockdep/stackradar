import { pgTable, uuid, varchar, unique } from "drizzle-orm/pg-core";
import { components } from "./components.js";

/**
 * Supported hash algorithms per CycloneDX spec
 * @see https://cyclonedx.org/docs/1.6/json/#components_items_hashes_items_alg
 */
export type HashAlgorithm =
    | "MD5"
    | "SHA-1"
    | "SHA-256"
    | "SHA-384"
    | "SHA-512"
    | "SHA3-256"
    | "SHA3-384"
    | "SHA3-512"
    | "BLAKE2b-256"
    | "BLAKE2b-384"
    | "BLAKE2b-512"
    | "BLAKE3";

/**
 * Stores cryptographic hashes for components.
 * Used for integrity verification and SLSA compliance.
 *
 * A component can have multiple hashes (e.g., both SHA-256 and SHA-512).
 */
export const componentHashes = pgTable(
    "component_hashes",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        componentId: uuid("component_id")
            .notNull()
            .references(() => components.id, { onDelete: "cascade" }),
        algorithm: varchar("algorithm", { length: 20 }).notNull().$type<HashAlgorithm>(),
        value: varchar("value", { length: 256 }).notNull(), // Max hash length (SHA-512 = 128 hex chars)
    },
    (table) => [
        // Each component can only have one hash per algorithm
        unique("component_hash_alg_unique").on(table.componentId, table.algorithm),
    ],
);

export type NewComponentHash = typeof componentHashes.$inferInsert;

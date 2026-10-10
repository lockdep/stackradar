/**
 * The community edition's one organisation and one cluster —
 * docs/open-source-plan-2026-10-10.md step 03.
 *
 * A community install is the dashboard for the cluster it runs in. The
 * multi-tenant model stays (`orgId` is everywhere, and removing it would be
 * a rewrite plus two codebases); what changes is that exactly one
 * organisation and one cluster exist, both created here at start-up rather
 * than by the first user's wizard. The first account to sign in owns the
 * organisation and every later one joins it as a member
 * (`user.controller.setup`); nobody can create a second organisation or add
 * a cluster (`middleware/edition.ts`).
 *
 * Shaped like `platform.service.ts`: a read-path `find*` that never creates,
 * and an idempotent, race-safe `ensure*` that the server process calls before
 * it listens. Called with the bootstrap credential from the environment
 * (`lib/bootstrap-cluster.ts`), it also makes the scanner's cluster row and
 * key exist before anyone has logged in — the chart renders the same two
 * values into the scanner's Secret, so an install scans itself with no
 * second step.
 *
 * Never called on the cloud: there every organisation is a tenant's own,
 * created on sign-up, and a row with slug `default` would be a tenant called
 * "Default".
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { apiKeyVault } from "../lib/api-key-vault.js";
import type { BootstrapCluster } from "../lib/bootstrap-cluster.js";
import { createLogger } from "../lib/logger.js";
import { isUniqueViolationOn } from "../lib/pg-errors.js";
import { apiKeyPrefix, hashApiKey } from "../utils/api-key.js";

const log = createLogger("default-org");

export const DEFAULT_ORG_SLUG = "default";
export const DEFAULT_ORG_NAME = "Default organization";
/** The one cluster: the install's own. Renamed from the cluster's settings whenever it suits; nothing keys on the name. */
export const DEFAULT_CLUSTER_NAME = "local";
/** The key row's `name`, so an audit reader can tell the env-provided key from a minted one. */
export const BOOTSTRAP_KEY_NAME = "Cluster Scanner Key (bootstrap)";
const SCANNER_KEY_SCOPES = ["sbom:write"];

export interface DefaultOrganization {
    orgId: string;
    /** The bootstrap cluster, when the credential was configured; null when the install has no cluster yet. */
    clusterId: string | null;
}

export class DefaultOrganizationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DefaultOrganizationError";
    }
}

const liveDefaultOrg = and(
    eq(schema.organizations.slug, DEFAULT_ORG_SLUG),
    eq(schema.organizations.system, false),
    isNull(schema.organizations.deletedAt),
);

/**
 * The default organisation, when it exists — the **read-path** lookup. A
 * request path must never create rows; the one request that may need the
 * org before start-up has made it (a test, or a login racing the seed)
 * calls `ensureDefaultOrganization()` instead, which is idempotent.
 */
export async function findDefaultOrganization(): Promise<{ orgId: string } | null> {
    const [org] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(liveDefaultOrg);
    return org ? { orgId: org.id } : null;
}

/**
 * Find-or-create the default organisation and, given the bootstrap
 * credential, its cluster and scanner key. Idempotent and safe to race: two
 * replicas starting together both end with the same rows. Re-running with
 * the same values changes nothing; a changed key rotates (the old row is
 * deactivated, the new one inserted); a changed cluster id is a new cluster
 * only if the name is free, otherwise a clear error, because the operator
 * has two clusters' worth of configuration and one install.
 */
export async function ensureDefaultOrganization(bootstrap: BootstrapCluster | null = null): Promise<DefaultOrganization> {
    const orgId = await ensureOrganization();
    if (!bootstrap) return { orgId, clusterId: null };

    const clusterId = await ensureBootstrapCluster(orgId, bootstrap.clusterId);
    await ensureBootstrapKey(orgId, clusterId, bootstrap.apiKey);
    return { orgId, clusterId };
}

async function ensureOrganization(): Promise<string> {
    let [org] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(liveDefaultOrg);
    if (!org) {
        try {
            [org] = await db
                .insert(schema.organizations)
                .values({ name: DEFAULT_ORG_NAME, slug: DEFAULT_ORG_SLUG, plan: "community", system: false })
                .returning({ id: schema.organizations.id });
            log.info({ orgId: org!.id }, "Seeded the default organization");
        } catch (error) {
            // The other replica won the insert; the slug index is what tells us.
            if (!isUniqueViolationOn(error, "organizations_slug_active_unique")) throw error;
            [org] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(liveDefaultOrg);
        }
    }
    if (!org) throw new DefaultOrganizationError("Failed to seed the default organization");
    return org.id;
}

async function ensureBootstrapCluster(orgId: string, clusterId: string): Promise<string> {
    const [existing] = await db
        .select({ id: schema.clusters.id, orgId: schema.clusters.orgId })
        .from(schema.clusters)
        .where(eq(schema.clusters.id, clusterId));

    if (existing) {
        // Never adopt a row across organisations: on a database that once
        // ran as something else, the id could name someone's cluster.
        if (existing.orgId !== orgId) {
            throw new DefaultOrganizationError(
                "BOOTSTRAP_CLUSTER_ID names a cluster that belongs to another organization; refusing to start",
            );
        }
        return existing.id;
    }

    try {
        await db
            .insert(schema.clusters)
            .values({
                id: clusterId,
                orgId,
                name: DEFAULT_CLUSTER_NAME,
                description: "The cluster this StackRadar runs in",
            })
            // The other replica inserted the same id a moment ago.
            .onConflictDoNothing({ target: schema.clusters.id });
        log.info({ clusterId }, "Seeded the bootstrap cluster");
    } catch (error) {
        if (isUniqueViolationOn(error, "clusters_name_org_unique")) {
            throw new DefaultOrganizationError(
                `A cluster named "${DEFAULT_CLUSTER_NAME}" already exists with a different id than BOOTSTRAP_CLUSTER_ID; ` +
                    "rename it, or set BOOTSTRAP_CLUSTER_ID to its id",
            );
        }
        throw error;
    }
    return clusterId;
}

/**
 * The key row for the env-provided credential, hashed exactly as
 * `generateApiKey()` hashes a minted one so `validateApiKey` cannot tell
 * them apart. `created_by` is null: the server stored this, before any user
 * existed (`db/schema/api-keys.ts`).
 */
async function ensureBootstrapKey(orgId: string, clusterId: string, apiKey: string): Promise<void> {
    const keyHash = hashApiKey(apiKey);
    const active = await db
        .select({ id: schema.apiKeys.id, keyHash: schema.apiKeys.keyHash, keyCiphertext: schema.apiKeys.keyCiphertext })
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.clusterId, clusterId), eq(schema.apiKeys.isActive, true)));

    const current = active.find((k) => k.keyHash === keyHash);
    if (current) {
        // Same key as last start: nothing to rotate. A row stored while the
        // vault was off gets its ciphertext now, so "reveal" works after the
        // operator sets API_KEY_ENCRYPTION_KEY, as it would for a minted key
        // that was rotated.
        if (current.keyCiphertext === null && apiKeyVault.enabled) {
            await db
                .update(schema.apiKeys)
                .set({ keyCiphertext: apiKeyVault.encrypt(apiKey, keyHash) })
                .where(eq(schema.apiKeys.id, current.id));
        }
        return;
    }

    try {
        await db.transaction(async (tx) => {
            // A changed BOOTSTRAP_CLUSTER_API_KEY is a rotation: the previous
            // key stops authenticating the instant the new one starts, same
            // as `rotateApiKey`. Revoked rather than deleted, as everywhere —
            // the row is the audit trail.
            await tx
                .update(schema.apiKeys)
                .set({ isActive: false, revokedAt: new Date() })
                .where(and(eq(schema.apiKeys.clusterId, clusterId), eq(schema.apiKeys.isActive, true)));
            await tx.insert(schema.apiKeys).values({
                orgId,
                clusterId,
                createdBy: null,
                name: BOOTSTRAP_KEY_NAME,
                keyPrefix: apiKeyPrefix(apiKey),
                keyHash,
                keyCiphertext: apiKeyVault.encrypt(apiKey, keyHash),
                scopes: SCANNER_KEY_SCOPES,
            });
        });
        log.info(
            { clusterId, keyPrefix: apiKeyPrefix(apiKey), rotated: active.length > 0 },
            active.length > 0 ? "Rotated the bootstrap scanner key" : "Stored the bootstrap scanner key",
        );
    } catch (error) {
        // The other replica stored the same key first: one active row per
        // hash is the index's promise, and the row it kept is the one we
        // wanted.
        if (!isUniqueViolationOn(error, "api_keys_key_hash_active_unique")) throw error;
    }
}

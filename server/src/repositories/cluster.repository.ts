import { eq, and, exists, getTableColumns, inArray, sql, count } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { clusters, apiKeys, organizations, type Cluster, type NewCluster } from "../db/schema/index.js";
import { generateApiKey } from "../lib/api-key.js";
import { apiKeyVault } from "../lib/api-key-vault.js";
import { deleteImagesForCluster } from "./delete-helpers.js";
import { AppError } from "../middleware/error-handler.js";

/**
 * Cluster enriched with a boolean flag indicating whether it currently has an
 * active API key. Callers use this to decide whether generating a new key is
 * a first-time setup or a rotation that will revoke an existing key.
 */
export type ClusterWithApiKeyStatus = Cluster & { hasApiKey: boolean };

/** One row of the org settings API keys tab; see `listApiKeysByOrg`. */
export type ClusterApiKeyRow = {
    clusterId: string;
    clusterName: string;
    scannerVersion: string | null;
    scannerLastSeenAt: Date | null;
    key: {
        keyPrefix: string;
        createdAt: Date;
        lastUsedAt: Date | null;
        /** Whether a vault copy exists — `revealable` once the controller ANDs in "vault on". */
        hasCiphertext: boolean;
        lastRevealedAt: Date | null;
    } | null;
};

// Correlated EXISTS built via `exists()` so both `api_keys.cluster_id` and the
// outer `clusters.id` are table-qualified. A plain sql`` template leaves the
// outer reference unqualified, which Postgres then resolves to `api_keys.id`
// inside the subquery and silently always returns false.
//
// Piggy-backs on `api_keys_cluster_id_idx` and short-circuits on the first
// active row, so this is cheap even for orgs with many keys.
const hasApiKeyExpr = sql<boolean>`${exists(
    db
        .select({ one: sql`1` })
        .from(apiKeys)
        .where(and(eq(apiKeys.clusterId, clusters.id), eq(apiKeys.isActive, true))),
)}`;

// Every cluster key is the same credential — one scanner, one scope — whether
// it was minted with the cluster or by a later rotation. Named once so the two
// paths cannot drift.
const SCANNER_KEY_NAME = "Cluster Scanner Key";
const SCANNER_KEY_SCOPES = ["sbom:write"];

/**
 * No API key may ever exist for the platform org or cluster — enforced here
 * (the only two key-write paths) rather than by convention. A key for the platform cluster would be a
 * credential that can write SBOMs every tenant's suggestions read, which is
 * exactly the poisoning shape ADR 0006 closed.
 */
async function assertNotSystem(orgId: string, clusterId: string | null): Promise<void> {
    const [org] = await db
        .select({ system: organizations.system })
        .from(organizations)
        .where(eq(organizations.id, orgId));
    if (org?.system) {
        throw new AppError(403, "API keys cannot be created for a system organization");
    }
    if (clusterId) {
        const [cluster] = await db.select({ system: clusters.system }).from(clusters).where(eq(clusters.id, clusterId));
        if (cluster?.system) {
            throw new AppError(403, "API keys cannot be created for a system cluster");
        }
    }
}

export const clusterRepository = {
    async findAllByOrg(orgId: string): Promise<ClusterWithApiKeyStatus[]> {
        return db
            .select({ ...getTableColumns(clusters), hasApiKey: hasApiKeyExpr })
            .from(clusters)
            .where(eq(clusters.orgId, orgId));
    },

    async findById(id: string, orgId: string): Promise<ClusterWithApiKeyStatus | undefined> {
        const [result] = await db
            .select({ ...getTableColumns(clusters), hasApiKey: hasApiKeyExpr })
            .from(clusters)
            .where(and(eq(clusters.id, id), eq(clusters.orgId, orgId)))
            .limit(1);
        return result;
    },

    async countByOrg(orgId: string): Promise<number> {
        const [result] = await db.select({ count: count() }).from(clusters).where(eq(clusters.orgId, orgId));
        return result?.count ?? 0;
    },

    /**
     * Create a cluster together with its scanner API key, in one transaction.
     *
     * There is no such thing as a useful cluster without a key: the scanner is
     * the only thing that ever writes to one, and it authenticates with
     * nothing else. Minting the key as a separate step left a window in which
     * a cluster existed that could not be connected, and made the user press a
     * button whose only possible answer was yes.
     *
     * Transactional because the plaintext key is returned exactly once — a
     * cluster row that survived a failed key insert would be a cluster nobody
     * could ever connect without rotating first.
     *
     * When `maxClusters` is given, the plan limit is enforced inside the same
     * transaction under a `SELECT FOR UPDATE` on the organization row — the
     * same pattern invite acceptance uses for the member limit — so two
     * concurrent creates serialize and cannot both pass the count. The caller
     * (the controller) owns the policy of which limit applies; this method
     * only guarantees the check and the insert are atomic.
     */
    async createWithApiKey(
        data: NewCluster,
        createdBy: string,
        opts?: { maxClusters?: number },
    ): Promise<{ cluster: ClusterWithApiKeyStatus; apiKey: string }> {
        // A system cluster is created without a key (`platform.service.ts`),
        // and a key must never be mintable under the system org at all.
        if (data.system) {
            throw new AppError(403, "API keys cannot be created for a system cluster");
        }
        await assertNotSystem(data.orgId, null);

        const { key, keyPrefix, keyHash } = generateApiKey();

        const cluster = await db.transaction(async (tx) => {
            if (opts?.maxClusters !== undefined) {
                await tx
                    .select({ id: organizations.id })
                    .from(organizations)
                    .where(eq(organizations.id, data.orgId))
                    .for("update")
                    .limit(1);
                const [row] = await tx.select({ count: count() }).from(clusters).where(eq(clusters.orgId, data.orgId));
                if ((row?.count ?? 0) >= opts.maxClusters) {
                    throw new AppError(
                        403,
                        `Your plan allows a maximum of ${opts.maxClusters} cluster(s). Upgrade to add more.`,
                        true,
                        "PLAN_LIMIT_EXCEEDED",
                    );
                }
            }

            const [created] = await tx.insert(clusters).values(data).returning();

            await tx.insert(apiKeys).values({
                orgId: created!.orgId,
                clusterId: created!.id,
                createdBy,
                name: SCANNER_KEY_NAME,
                keyPrefix,
                keyHash,
                keyCiphertext: apiKeyVault.encrypt(key, keyHash),
                scopes: SCANNER_KEY_SCOPES,
            });

            return created!;
        });

        // Known by construction — the key was inserted in the same transaction,
        // so skip the EXISTS probe.
        return { cluster: { ...cluster, hasApiKey: true }, apiKey: key };
    },

    async update(
        id: string,
        orgId: string,
        data: Partial<Pick<NewCluster, "name" | "description">>,
    ): Promise<ClusterWithApiKeyStatus | undefined> {
        const [updated] = await db
            .update(clusters)
            .set({ ...data, updatedAt: new Date() })
            .where(and(eq(clusters.id, id), eq(clusters.orgId, orgId)))
            .returning();
        if (!updated) return undefined;
        // Re-read via findById so the response carries `hasApiKey` consistently
        // with list/get endpoints. The row is already in cache from the UPDATE,
        // so this is a single index lookup.
        return this.findById(id, orgId);
    },

    /**
     * Delete a cluster, revoking its scanner keys on the way out.
     *
     * The revoke is not housekeeping. `api_keys.cluster_id` is `ON DELETE SET
     * NULL`, so without it the cluster's scanner key survives the delete as an
     * *org-scoped* key that is still `isActive` and still carries `sbom:write`
     * — a credential the user believes they destroyed, now with wider reach
     * than it had before. Revoking first, in the same transaction, means the
     * key cannot be valid for even the instant between the two statements.
     *
     * Revoked rather than deleted, matching `revokeApiKey`: the row is the
     * audit trail of a key that once existed and was used, and the partial
     * unique index on `key_hash` only covers active keys, so keeping it costs
     * nothing.
     *
     * Namespaces, workloads, helm releases and metrics snapshots go by FK
     * cascade off the cluster row. Images do **not**: since ADR 0006 the
     * cluster owns its images — and their SBOMs, components and match rows —
     * outright, and they are deleted here explicitly, containers first,
     * because `workload_containers.image_id` is `ON DELETE RESTRICT` and a
     * cascade racing into that restrict is an order-dependent failure. The
     * result is the clean cascade the ADR promises: nothing of the cluster's
     * data outlives it.
     */
    async delete(id: string, orgId: string): Promise<boolean> {
        return db.transaction(async (tx) => {
            // Scoped by orgId first: a caller from another org must not be able
            // to revoke keys for a cluster it cannot see, even though the
            // delete below would be a no-op for them.
            const [cluster] = await tx
                .select({ id: clusters.id })
                .from(clusters)
                .where(and(eq(clusters.id, id), eq(clusters.orgId, orgId)))
                .limit(1);
            if (!cluster) return false;

            await tx
                .update(apiKeys)
                .set({ isActive: false, revokedAt: new Date() })
                .where(and(eq(apiKeys.clusterId, id), eq(apiKeys.isActive, true)));

            // The cluster's containers, ahead of its images: they RESTRICT
            // image deletion, and the namespace-side cascade fires too late.
            const namespaceIdsInCluster = tx
                .select({ id: schema.namespaces.id })
                .from(schema.namespaces)
                .where(eq(schema.namespaces.clusterId, id));
            const workloadIdsInCluster = tx
                .select({ id: schema.workloads.id })
                .from(schema.workloads)
                .where(inArray(schema.workloads.namespaceId, namespaceIdsInCluster));
            await tx
                .delete(schema.workloadContainers)
                .where(inArray(schema.workloadContainers.workloadId, workloadIdsInCluster));

            await deleteImagesForCluster(tx, id);

            const result = await tx
                .delete(clusters)
                .where(and(eq(clusters.id, id), eq(clusters.orgId, orgId)))
                .returning();
            return result.length > 0;
        });
    },

    /**
     * Create a cluster-scoped API key.
     * Revokes any existing active key for this cluster first.
     * Returns the plaintext key (only time it's visible).
     */
    async rotateApiKey(clusterId: string, orgId: string, createdBy: string): Promise<string> {
        await assertNotSystem(orgId, clusterId);

        // Revoke existing cluster keys
        await db
            .update(apiKeys)
            .set({ isActive: false, revokedAt: new Date() })
            .where(and(eq(apiKeys.clusterId, clusterId), eq(apiKeys.isActive, true)));

        const { key, keyPrefix, keyHash } = generateApiKey();

        await db.insert(apiKeys).values({
            orgId,
            clusterId,
            createdBy,
            name: SCANNER_KEY_NAME,
            keyPrefix,
            keyHash,
            keyCiphertext: apiKeyVault.encrypt(key, keyHash),
            scopes: SCANNER_KEY_SCOPES,
        });

        return key;
    },

    /**
     * Revoke all active API keys for a cluster.
     */
    async revokeApiKey(clusterId: string): Promise<void> {
        await db
            .update(apiKeys)
            .set({ isActive: false, revokedAt: new Date() })
            .where(and(eq(apiKeys.clusterId, clusterId), eq(apiKeys.isActive, true)));
    },

    /**
     * Record a scanner "ping" from an authenticated agent request: always
     * bumps `scanner_last_seen_at`, and updates `scanner_version` when the
     * agent reports one via the `X-Scanner-Version` request header. Called
     * fire-and-forget from the auth middleware on every cluster-scoped API
     * key request, so the UI can flag clusters running outdated or silent
     * scanners.
     */
    async recordScannerPing(clusterId: string, version: string | undefined): Promise<void> {
        await db
            .update(clusters)
            .set({
                scannerLastSeenAt: new Date(),
                ...(version ? { scannerVersion: version } : {}),
            })
            .where(eq(clusters.id, clusterId));
    },

    /**
     * Record the cluster's Kubernetes version from a heartbeat's
     * `X-Kubernetes-Version` header. Written only when the scanner reported
     * one — an older scanner, or a failed `/version` read, must not erase
     * knowledge — which is why the caller passes `undefined` rather than
     * calling with an empty value.
     */
    async recordKubernetesVersion(clusterId: string, version: string): Promise<void> {
        await db.update(clusters).set({ kubernetesVersion: version }).where(eq(clusters.id, clusterId));
    },

    /**
     * `kubernetes_version` per cluster in the org — the suggestion feed's
     * lookup for kube-constraint warnings. Null values included: unknown is a
     * value, and it renders as silence.
     */
    async kubernetesVersionsForOrg(orgId: string): Promise<Map<string, string | null>> {
        const rows = await db
            .select({ id: clusters.id, kubernetesVersion: clusters.kubernetesVersion })
            .from(clusters)
            .where(eq(clusters.orgId, orgId));
        return new Map(rows.map((r) => [r.id, r.kubernetesVersion]));
    },

    /**
     * Record whether the last inventory report could read its workloads'
     * controllers.
     *
     * Stored on the cluster rather than returned only in the response, because
     * the *client* is what has to say it: without this the UI cannot tell "no
     * chart claims these workloads" from "the agent was not allowed to look",
     * and it states the first while the second is true. Written on every
     * inventory report, so revoking or granting the RBAC takes effect within
     * one interval.
     */
    async recordOwnerMetadataCollected(clusterId: string, collected: boolean): Promise<void> {
        await db.update(clusters).set({ ownerMetadataCollected: collected }).where(eq(clusters.id, clusterId));
    },

    /**
     * Get the active API key record for a cluster (masked, for display).
     */
    async getActiveApiKey(clusterId: string) {
        const [key] = await db
            .select()
            .from(apiKeys)
            .where(and(eq(apiKeys.clusterId, clusterId), eq(apiKeys.isActive, true)))
            .limit(1);
        return key ?? null;
    },

    /**
     * Every cluster of the org with its active scanner key's metadata — the
     * org settings API keys tab in one query. Masked by construction: the
     * ciphertext is reduced to "is there one", the hash never leaves. A
     * cluster with no active key has `key: null`.
     */
    async listApiKeysByOrg(orgId: string): Promise<ClusterApiKeyRow[]> {
        const rows = await db
            .select({
                clusterId: clusters.id,
                clusterName: clusters.name,
                scannerVersion: clusters.scannerVersion,
                scannerLastSeenAt: clusters.scannerLastSeenAt,
                keyId: apiKeys.id,
                keyPrefix: apiKeys.keyPrefix,
                keyCreatedAt: apiKeys.createdAt,
                keyLastUsedAt: apiKeys.lastUsedAt,
                keyHasCiphertext: sql<boolean>`${apiKeys.keyCiphertext} IS NOT NULL`,
                keyLastRevealedAt: apiKeys.lastRevealedAt,
            })
            .from(clusters)
            .leftJoin(apiKeys, and(eq(apiKeys.clusterId, clusters.id), eq(apiKeys.isActive, true)))
            .where(eq(clusters.orgId, orgId))
            .orderBy(clusters.name, apiKeys.createdAt);

        // Rotation revokes before it inserts, so one active key per cluster
        // is the invariant; should a second ever slip in, the newest wins
        // rather than the cluster appearing twice.
        const byCluster = new Map<string, ClusterApiKeyRow>();
        for (const r of rows) {
            byCluster.set(r.clusterId, {
                clusterId: r.clusterId,
                clusterName: r.clusterName,
                scannerVersion: r.scannerVersion,
                scannerLastSeenAt: r.scannerLastSeenAt,
                key:
                    r.keyId === null
                        ? null
                        : {
                              keyPrefix: r.keyPrefix!,
                              createdAt: r.keyCreatedAt!,
                              lastUsedAt: r.keyLastUsedAt,
                              hasCiphertext: r.keyHasCiphertext ?? false,
                              lastRevealedAt: r.keyLastRevealedAt,
                          },
            });
        }
        return [...byCluster.values()];
    },

    /** Stamps the reveal on the key row; who did it is in the audit log line. */
    async markApiKeyRevealed(keyId: string): Promise<void> {
        await db.update(apiKeys).set({ lastRevealedAt: new Date() }).where(eq(apiKeys.id, keyId));
    },
};

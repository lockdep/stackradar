import type { Request, Response, NextFunction } from "express";
import {
    clusterRepository,
    packageRepository,
    riskScoreRepository,
    vulnerabilityRepository,
    workloadRepository,
    type ClusterWithApiKeyStatus,
} from "../repositories/index.js";
import type { ClusterCoverage } from "../repositories/workload.repository.js";
import {
    createClusterSchema,
    updateClusterSchema,
    clusterComponentsQuerySchema,
    clusterVulnerabilitiesQuerySchema,
    clusterVulnerabilityOccurrencesQuerySchema,
    clusterPackageOccurrencesQuerySchema,
    clusterRiskScoreQuerySchema,
    clusterRiskScoreFindingsQuerySchema,
    uuidParamSchema,
} from "../schemas/index.js";
import { clusterRiskScores, emptyRiskRollup, orgRiskRollup, type RiskRollup } from "../db/risk.js";
import { REPORTED_SEVERITIES } from "../db/findings.js";
import { parseTierParam } from "../db/finding-tier.js";
import { AppError } from "../middleware/error-handler.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { getPlanLimits } from "../config/plans.js";
import { isUniqueViolationOn } from "../lib/pg-errors.js";
import { apiKeyVault, ApiKeyVaultError } from "../lib/api-key-vault.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("cluster.controller");

/**
 * Names are unique per org (`clusters_name_org_unique`). A collision is the
 * user's to resolve, so it is a 409 with a message they can act on rather
 * than the 500 a raw unique violation would become.
 */
function rejectDuplicateName(error: unknown): never {
    if (isUniqueViolationOn(error, "clusters_name_org_unique")) {
        throw new AppError(409, "A cluster with that name already exists in this organization");
    }
    throw error;
}

declare global {
    namespace Express {
        interface Request {
            /** The caller's cluster, loaded by {@link requireOwnedCluster}. */
            cluster?: ClusterWithApiKeyStatus;
        }
    }
}

/**
 * Resolve the `:id` cluster and prove the caller's org owns it, or 404.
 *
 * Ownership is not implied by the cluster id in the path — check it
 * before reading anything scoped only by cluster.
 *
 * Mounted as `router.param("id", requireOwnedCluster)` so every route with an
 * `:id` gets the check; handlers read the loaded row off `req.cluster`.
 */
export function requireOwnedCluster(req: Request, _res: Response, next: NextFunction, id: string): void {
    (async () => {
        // 400 on a non-UUID rather than letting Postgres reject the cast as
        // a 500 — the id is user-typed input like any other.
        uuidParamSchema.parse({ id });
        const cluster = await clusterRepository.findById(id, asAuthed(req).auth.orgId);
        if (!cluster) throw new AppError(404, "Cluster not found");
        req.cluster = cluster;
        next();
    })().catch(next);
}

/**
 * The enrichment every cluster response carries — the same shape whether the
 * cluster arrives alone or in the org list, so one cluster and a list of
 * clusters look identical to every consumer.
 *
 * `null`, not `0`, when no inventory has been reported: a scanner too old to
 * report inventory is a different thing from a cluster running nothing, and
 * the UI must not show "0 discovered" for the former. `scanned` comes from the
 * same `LEFT JOIN` as `discovered`, so `scanned <= discovered` holds by
 * construction.
 */
function withCoverage<C>(cluster: C, inventory: ClusterCoverage | null | undefined, risk: RiskRollup | undefined) {
    return {
        ...cluster,
        discoveredWorkloads: inventory?.discovered ?? null,
        scannedWorkloads: inventory?.scanned ?? null,
        inventoryReportedAt: inventory?.reportedAt ?? null,
        /* Empty, not null, with no inventory: "no known auth failure" is true
           of a cluster we have never heard from, and the Dashboard banner
           only needs to know whether there is something to raise. */
        registryAuthFailedHosts: inventory?.registryAuthFailedHosts ?? [],
        registryAuthFailedWorkloads: inventory?.registryAuthFailedWorkloads ?? 0,
        risk: risk ?? emptyRiskRollup(),
    };
}

export const clusterController = {
    /**
     * The org's clusters as `{ id, name }` and nothing else — for a scope
     * picker. `list` folds coverage and risk for the whole org on every call,
     * which a dropdown has no use for.
     * @route GET /api/clusters/names
     */
    async names(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const clusters = await clusterRepository.findAllByOrg(auth.orgId);
            res.json({ clusters: clusters.map((c) => ({ id: c.id, name: c.name })) });
        } catch (error) {
            next(error);
        }
    },

    /**
     * List all clusters for the org
     * @route GET /api/clusters
     */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { orgId });
            /* Inventory rides along on the list rather than living behind its
               own endpoint: the Dashboard already fetches clusters, and
               discovered-vs-scanned is only meaningful next to the cluster it
               belongs to. One grouped aggregate for the whole org, not one
               query per cluster. */
            const [clusters, inventory, orgRisk] = await Promise.all([
                time("findAllByOrg", clusterRepository.findAllByOrg(orgId)),
                time("coverageByOrg", workloadRepository.coverageByOrg(orgId)),
                /* The Dashboard's headline total rides along here for the same
                   reason inventory does: it already fetches clusters, and one
                   fold over the org's findings beats a second endpoint. */
                time("orgRiskRollup", orgRiskRollup(orgId)),
            ]);
            const risk = await time("clusterRiskScores", clusterRiskScores(clusters.map((c) => c.id)));

            const byCluster = new Map(inventory.map((i) => [i.clusterId, i]));
            res.json({
                clusters: clusters.map((cluster) =>
                    withCoverage(cluster, byCluster.get(cluster.id), risk.get(cluster.id)),
                ),
                risk: orgRisk,
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get a single cluster
     * @route GET /api/clusters/:id
     */
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const [inventory, risk] = await Promise.all([
                time("coverageByCluster", workloadRepository.coverageByCluster(cluster.id)),
                time("clusterRiskScores", clusterRiskScores([cluster.id])),
            ]);

            res.json({ cluster: withCoverage(cluster, inventory, risk.get(cluster.id)) });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Create a new cluster, along with the scanner API key it needs to be of
     * any use.
     *
     * The key comes back in this response and nowhere else — it is hashed
     * before it is stored, exactly as a rotated key is. A caller that drops it
     * has to rotate; that is the same bargain every other key here makes, and
     * it is why the key is not a second request the UI could forget to send.
     *
     * @route POST /api/clusters
     */
    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            // Present by requireInternal: only BFF requests carry a user, and
            // the key's created_by must be a real member, not a machine.
            const userId = auth.userId;
            if (!userId) throw new AppError(401, "User context required");
            const data = createClusterSchema.parse(req.body);
            const time = createQueryTimer(log, { orgId });

            // The plan limit is enforced inside the create transaction, under
            // a lock on the org row — a check-then-insert here would let two
            // concurrent requests both pass the count.
            const limits = getPlanLimits(auth.org.plan);
            const { cluster, apiKey } = await time(
                "createWithApiKey",
                clusterRepository.createWithApiKey(
                    { orgId, ...data },
                    userId,
                    limits.clusters === Infinity ? {} : { maxClusters: limits.clusters },
                ),
            ).catch(rejectDuplicateName);
            log.info({ orgId, clusterId: cluster.id, name: cluster.name }, "Cluster created with scanner API key");

            // A freshly-created cluster cannot have reported an inventory yet,
            // and has nothing scanned — so its risk is the empty rollup.
            res.status(201).json({
                cluster: withCoverage(cluster, null, undefined),
                apiKey,
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Update a cluster
     * @route PATCH /api/clusters/:id
     */
    async update(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const { id } = req.params;
            const orgId = auth.orgId;
            const data = updateClusterSchema.parse(req.body);
            const time = createQueryTimer(log, { clusterId: id, orgId });

            const cluster = await time(
                "update",
                clusterRepository.update(id!, orgId, data as { name?: string; description?: string }),
            ).catch(rejectDuplicateName);
            if (!cluster) throw new AppError(404, "Cluster not found");

            const [inventory, risk] = await Promise.all([
                time("coverageByCluster", workloadRepository.coverageByCluster(cluster.id)),
                time("clusterRiskScores", clusterRiskScores([cluster.id])),
            ]);

            log.info({ orgId, clusterId: id }, "Cluster updated");
            res.json({ cluster: withCoverage(cluster, inventory, risk.get(cluster.id)) });
        } catch (error) {
            next(error);
        }
    },

    /**
     * The containers this cluster is running whose image has no SBOM yet.
     *
     * The counts on the cluster itself answer "how complete is my coverage";
     * this answers "which ones are missing", which is the only form of the
     * question anybody can act on. Its own endpoint rather than a field on the
     * cluster because it is a list of unbounded length and nothing on the
     * Dashboard needs it — only the cluster page asks, and only when the
     * counts already say there is a gap.
     *
     * @route GET /api/clusters/:id/coverage
     */
    async coverage(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const [counts, unscanned] = await Promise.all([
                time("coverageByCluster", workloadRepository.coverageByCluster(cluster.id)),
                time("findUnscannedByCluster", workloadRepository.findUnscannedByCluster(cluster.id)),
            ]);

            res.json({
                // All three null together when no inventory has ever arrived, so
                // the UI can tell "nothing reported" from "nothing missing".
                discovered: counts?.discovered ?? null,
                scanned: counts?.scanned ?? null,
                reportedAt: counts?.reportedAt ?? null,
                workloads: unscanned,
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * The distinct packages running in this cluster, aggregated by
     * name + version — the Packages tab.
     *
     * Search and pagination live in the query, not the client: the row unit
     * is every library of every scanned image, which is the largest set any
     * cluster surface pages over.
     *
     * @route GET /api/clusters/:id/components
     */
    async components(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const query = clusterComponentsQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const page = await time(
                "findPackages",
                packageRepository.findPackages(
                    { clusterId: cluster.id },
                    {
                        ...query,
                        severities: query.severity?.split(",").map((s) => s.trim().toLowerCase()),
                        kev: query.kev === "true",
                    },
                ),
            );

            res.json(page);
        } catch (error) {
            next(error);
        }
    },

    /**
     * Every vulnerability in this cluster, one row per advisory — the
     * Vulnerabilities tab. Severity filter, search and pagination are query
     * parameters; severity comes comma-joined (`severity=critical,high`)
     * exactly as the tab's URL carries it.
     *
     * @route GET /api/clusters/:id/vulnerabilities
     */
    async vulnerabilities(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const query = clusterVulnerabilitiesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const severities = query.severity
                ?.split(",")
                .map((s) => s.trim().toLowerCase())
                .filter((s) => s === "unscored" || (REPORTED_SEVERITIES as readonly string[]).includes(s));

            const page = await time(
                "findVulnerabilities",
                vulnerabilityRepository.findVulnerabilities(
                    { clusterId: cluster.id },
                    {
                        severities,
                        kev: query.kev === "true",
                        search: query.search,
                        tiers: parseTierParam(query.tier),
                        control: query.control,
                        /* The cluster is the path's; `?cluster=` means nothing here. */
                        within: { namespace: query.namespace },
                        sort: query.sort,
                        order: query.order,
                        limit: query.limit,
                        offset: query.offset,
                    },
                ),
            );

            res.json(page);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The images and workloads one advisory affects — what the Vulnerabilities
     * tab's count cells open to link the number to the things it counts.
     *
     * @route GET /api/clusters/:id/vulnerabilities/occurrences
     */
    async vulnerabilityOccurrences(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const query = clusterVulnerabilityOccurrencesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const occurrences = await time(
                "findVulnerabilityOccurrences",
                vulnerabilityRepository.findVulnerabilityOccurrences(
                    { clusterId: cluster.id },
                    query.identity,
                    parseTierParam(query.tier),
                    query.control,
                    { namespace: query.namespace },
                ),
            );

            res.json(occurrences);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The advisory metadata behind one Vulnerabilities-tab row — every record
     * the identity collapses in this cluster, plus the per-package fix
     * versions. The detail panel's fetch, resolved on expand.
     *
     * @route GET /api/clusters/:id/vulnerabilities/detail
     */
    async vulnerabilityDetail(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const query = clusterVulnerabilityOccurrencesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const detail = await time(
                "findVulnerabilityDetail",
                vulnerabilityRepository.findVulnerabilityDetail(
                    { clusterId: cluster.id },
                    query.identity,
                    parseTierParam(query.tier),
                ),
            );

            res.json(detail);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The Risk Score tab: every scanned image in the cluster with its share
     * of the cluster's Risk Score, largest first. `total` is the cluster's
     * current Risk Score — the same fold the Overview chart's latest point
     * is captured from.
     *
     * @route GET /api/clusters/:id/risk-score
     */
    async riskScore(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const query = clusterRiskScoreQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const page = await time(
                "findClusterRiskScoreImages",
                riskScoreRepository.findImages(
                    { clusterId: cluster.id },
                    {
                        limit: query.limit,
                        offset: query.offset,
                        control: query.control,
                    },
                ),
            );

            res.json(page);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The findings that add up to one image's share of the Risk Score —
     * the Risk Score tab's expand-row fetch. Largest contribution first.
     *
     * @route GET /api/clusters/:id/risk-score/findings
     */
    async riskScoreFindings(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const query = clusterRiskScoreFindingsQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const result = await time(
                "findClusterRiskScoreFindings",
                riskScoreRepository.findImageFindings(
                    { clusterId: cluster.id },
                    query.imageId,
                    parseTierParam(query.tier),
                ),
            );

            res.json(result);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The ecosystems this cluster's packages come from — the Packages tab's
     * Ecosystem menu.
     *
     * @route GET /api/clusters/:id/components/ecosystems
     */
    async componentEcosystems(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const ecosystems = await time(
                "findPackageEcosystems",
                packageRepository.findPackageEcosystems({ clusterId: cluster.id }),
            );

            res.json({ ecosystems });
        } catch (error) {
            next(error);
        }
    },

    /**
     * The images and workloads one package version occurs in — what the
     * Packages tab's count cells open to link the number to the things it
     * counts.
     *
     * @route GET /api/clusters/:id/components/occurrences
     */
    async componentOccurrences(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const query = clusterPackageOccurrencesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const occurrences = await time(
                "findPackageOccurrences",
                packageRepository.findPackageOccurrences(
                    { clusterId: cluster.id },
                    {
                        name: query.name,
                        version: query.version ?? null,
                        control: query.control,
                    },
                ),
            );

            res.json(occurrences);
        } catch (error) {
            next(error);
        }
    },

    /**
     * Delete a cluster
     * @route DELETE /api/clusters/:id
     */
    async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const { id } = req.params;
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { clusterId: id, orgId });

            const deleted = await time("delete", clusterRepository.delete(id!, orgId));
            if (!deleted) throw new AppError(404, "Cluster not found");

            log.info({ orgId, clusterId: id }, "Cluster deleted");
            res.json({ message: "Cluster deleted" });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Rotate the API key for a cluster (revokes old, creates new)
     * @route POST /api/clusters/:id/api-key
     */
    async rotateApiKey(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const orgId = auth.orgId;
            const userId = auth.userId;
            if (!userId) throw new AppError(401, "User context required");
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId });

            const key = await time("rotateApiKey", clusterRepository.rotateApiKey(cluster.id, orgId, userId));
            log.info({ orgId, clusterId: cluster.id }, "Cluster API key rotated");

            res.status(201).json({ apiKey: key });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get the active API key info for a cluster (masked)
     * @route GET /api/clusters/:id/api-key
     */
    async getApiKey(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId: auth.orgId });

            const key = await time("getActiveApiKey", clusterRepository.getActiveApiKey(cluster.id));
            if (!key) throw new AppError(404, "No active API key");

            res.json({
                apiKey: `${key.keyPrefix}••••••••••••••••••••`,
                createdAt: key.createdAt,
                lastUsedAt: key.lastUsedAt,
                /* Whether `POST …/api-key/reveal` would succeed — the client
                   shows a reveal control only when it would. */
                revealable: apiKeyVault.enabled && key.keyCiphertext !== null,
                lastRevealedAt: key.lastRevealedAt,
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Every cluster with its masked key metadata — the org settings API keys
     * tab. Member-visible like the per-cluster GET: nothing here is key
     * material.
     * @route GET /api/clusters/api-keys
     */
    async listApiKeys(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { orgId });
            const rows = await time("listApiKeysByOrg", clusterRepository.listApiKeysByOrg(orgId));
            res.json({
                clusters: rows.map((r) => ({
                    id: r.clusterId,
                    name: r.clusterName,
                    scannerVersion: r.scannerVersion,
                    scannerLastSeenAt: r.scannerLastSeenAt,
                    key:
                        r.key === null
                            ? null
                            : {
                                  apiKey: `${r.key.keyPrefix}••••••••••••••••••••`,
                                  createdAt: r.key.createdAt,
                                  lastUsedAt: r.key.lastUsedAt,
                                  revealable: apiKeyVault.enabled && r.key.hasCiphertext,
                                  lastRevealedAt: r.key.lastRevealedAt,
                              },
                })),
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Reveal the active API key for a cluster — the plaintext, again.
     *
     * A POST, not a GET, because it is an audited act with a side effect
     * (`last_revealed_at`), and because the demo org's read-only guard keys
     * on the method. Admin/owner-only at the route. The two refusals a client
     * must tell apart carry codes: `REVEAL_DISABLED` (no vault on this
     * server) and `KEY_NOT_REVEALABLE` (this key predates the vault, or was
     * encrypted under a key the server no longer has) — the fix for the
     * second is rotation.
     *
     * @route POST /api/clusters/:id/api-key/reveal
     */
    async revealApiKey(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const orgId = auth.orgId;
            const userId = auth.userId;
            if (!userId) throw new AppError(401, "User context required");
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId });

            const key = await time("getActiveApiKey", clusterRepository.getActiveApiKey(cluster.id));
            if (!key) throw new AppError(404, "No active API key");
            if (!apiKeyVault.enabled) {
                throw new AppError(503, "Revealing API keys is not enabled on this server", true, "REVEAL_DISABLED");
            }
            if (key.keyCiphertext === null) {
                throw new AppError(
                    409,
                    "This key was created before it could be stored for reveal. Rotate it to get a key that can be shown again.",
                    true,
                    "KEY_NOT_REVEALABLE",
                );
            }

            let plaintext: string;
            try {
                plaintext = apiKeyVault.decrypt(key.keyCiphertext, key.keyHash);
            } catch (error) {
                if (!(error instanceof ApiKeyVaultError)) throw error;
                // Encrypted under a key this server no longer has (a rotated
                // API_KEY_ENCRYPTION_KEY), or a row someone edited. Either
                // way the credential still authenticates, so the honest answer
                // is "rotate", the same as for a pre-vault key.
                log.error(
                    { orgId, clusterId: cluster.id, keyId: key.id, err: error },
                    "Cluster API key ciphertext failed to decrypt",
                );
                throw new AppError(
                    409,
                    "This key can no longer be shown. Rotate it to get a key that can be shown again.",
                    true,
                    "KEY_NOT_REVEALABLE",
                );
            }

            await time("markApiKeyRevealed", clusterRepository.markApiKeyRevealed(key.id));
            // The audit line: who saw which credential, from where. Nothing of
            // the key itself beyond the prefix the masked GET already shows.
            log.info(
                {
                    audit: "api_key.reveal",
                    orgId,
                    clusterId: cluster.id,
                    keyId: key.id,
                    keyPrefix: key.keyPrefix,
                    userId,
                    ip: req.ip,
                },
                "Cluster API key revealed",
            );

            res.json({ apiKey: plaintext, createdAt: key.createdAt });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Revoke the API key for a cluster
     * @route DELETE /api/clusters/:id/api-key
     */
    async revokeApiKey(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const cluster = req.cluster!;
            const orgId = auth.orgId;
            const time = createQueryTimer(log, { clusterId: cluster.id, orgId });

            await time("revokeApiKey", clusterRepository.revokeApiKey(cluster.id));
            log.info({ orgId, clusterId: cluster.id }, "Cluster API key revoked");

            res.json({ message: "API key revoked" });
        } catch (error) {
            next(error);
        }
    },
};

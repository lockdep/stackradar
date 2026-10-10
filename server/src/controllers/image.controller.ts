import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { imageRepository, clusterRepository, vulnerabilityRepository } from "../repositories/index.js";
import { orgRunsImage } from "../db/tenancy.js";
import { recommendForImage, recommendationsForOrg } from "../services/upgrade-recommendation.service.js";
import { loadGroupedFindings } from "../services/grouped-findings.service.js";
import { baseUpgradeForImage } from "../services/base-upgrade.service.js";
import { imageIdParamSchema } from "../schemas/index.js";
import { parseTierParam } from "../db/finding-tier.js";
import {
    clusterVulnerabilitiesQuerySchema,
    clusterVulnerabilityOccurrencesQuerySchema,
    groupedFindingsQuerySchema,
} from "../schemas/cluster.schema.js";
import { REPORTED_SEVERITIES } from "../db/findings.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

const log = createLogger("image-controller");

/**
 * The remediation view.
 *
 * One row per thing a user can actually change. "Bump `image:` from A to B" is
 * a single action however many workloads share it, and before the cutover there
 * was nowhere to hang that action — the same digest was N unrelated projects
 * with N SBOMs and N sets of findings.
 *
 * Ownership is `images.org_id` (ADR 0006), checked through `db/tenancy.ts` on
 * every endpoint. An uploaded-but-not-yet-inventoried image is visible to its
 * owning org with zero deployments — it is their upload — where the old
 * deployment-side proof hid it from everyone.
 *
 * There is no delete here, on purpose. Dropping a running image's SBOM would
 * only mean re-pulling and re-scanning it on the next inventory report, and an
 * undeployed one is reclaimed by the GC once it ages out — retention is a
 * fleet-level decision, not a per-request one.
 */

export const imageController = {
    /**
     * @route GET /api/images
     */
    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;

            const time = createQueryTimer(log, { orgId });
            const images = await time("findAllWithStats", imageRepository.findAllWithStats(orgId));
            res.json(images);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/images/:id
     */
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { imageId: id });

            const visible = await time("orgRunsImage", orgRunsImage(orgId, id));
            if (!visible) {
                throw new AppError(404, "Image not found");
            }

            const [image, deployments] = await Promise.all([
                time("findById", imageRepository.findById(id)),
                time("findDeployments", imageRepository.findDeployments(id, orgId)),
            ]);

            if (!image) {
                throw new AppError(404, "Image not found");
            }

            const [stats, cluster] = await Promise.all([
                time("findStatsById", imageRepository.findStatsById(id)),
                // The image is one cluster's view of the digest (ADR 0006);
                // the name is what tells sibling rows apart in the UI.
                time("findCluster", clusterRepository.findById(image.clusterId, orgId)),
            ]);
            // Same usage fields the list computes, derived from the rows
            // already in hand: the client's `Image` type promises them.
            const tags = [...new Set(deployments.map((d) => d.imageTag).filter((t): t is string => t != null))].sort();
            res.json({
                ...image,
                clusterName: cluster?.name ?? null,
                ...stats,
                containerCount: deployments.length,
                tags,
                deployments,
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Every place this image runs.
     *
     * @route GET /api/images/:id/deployments
     */
    async getDeployments(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { imageId: id });

            const visible = await time("orgRunsImage", orgRunsImage(orgId, id));
            if (!visible) {
                throw new AppError(404, "Image not found");
            }
            // May legitimately be empty: an uploaded-but-undeployed image.
            const deployments = await time("findDeployments", imageRepository.findDeployments(id, orgId));
            res.json(deployments);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The image's findings, grouped by component — the same table a
     * workload's Vulnerabilities tab shows, because the findings are the
     * image's (ADR 0004) and the container only names it.
     *
     * @route GET /api/images/:id/vulnerabilities/grouped
     *
     * No deployment facts (tag, ref) on the SBOM block: a digest may run
     * under several tags, and picking one would be a guess.
     */
    async getVulnerabilitiesGrouped(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { imageId: id });

            const visible = await time("orgRunsImage", orgRunsImage(orgId, id));
            if (!visible) {
                throw new AppError(404, "Image not found");
            }

            const { tier } = groupedFindingsQuerySchema.parse(req.query);
            res.json(await time("loadGroupedFindings", loadGroupedFindings(id, null, parseTierParam(tier))));
        } catch (error) {
            next(error);
        }
    },

    /**
     * The image's vulnerabilities, one row per advisory — the list the
     * cluster tab and `/vulnerabilities` show, over this one image. The
     * scope filters (`cluster`, `namespace`, `control`) mean nothing on a
     * single image and are not read.
     *
     * @route GET /api/images/:id/vulnerabilities
     */
    async vulnerabilities(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const query = clusterVulnerabilitiesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { imageId: id, orgId });

            const severities = query.severity
                ?.split(",")
                .map((s) => s.trim().toLowerCase())
                .filter((s) => s === "unscored" || (REPORTED_SEVERITIES as readonly string[]).includes(s));

            /* The org is in the scope itself, so another org's image id
               lists nothing — no separate ownership read. */
            const page = await time(
                "findVulnerabilities",
                vulnerabilityRepository.findVulnerabilities({ orgId, imageId: id }, {
                    severities,
                    kev: query.kev === "true",
                    search: query.search,
                    tiers: parseTierParam(query.tier),
                    sort: query.sort,
                    order: query.order,
                    limit: query.limit,
                    offset: query.offset,
                }),
            );

            res.json(page);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/images/:id/vulnerabilities/occurrences
     */
    async vulnerabilityOccurrences(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const query = clusterVulnerabilityOccurrencesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { imageId: id, orgId });

            const occurrences = await time(
                "findVulnerabilityOccurrences",
                vulnerabilityRepository.findVulnerabilityOccurrences(
                    { orgId, imageId: id },
                    query.identity,
                    parseTierParam(query.tier),
                ),
            );

            res.json(occurrences);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/images/:id/vulnerabilities/detail
     */
    async vulnerabilityDetail(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const query = clusterVulnerabilityOccurrencesQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { imageId: id, orgId });

            const detail = await time(
                "findVulnerabilityDetail",
                vulnerabilityRepository.findVulnerabilityDetail(
                    { orgId, imageId: id },
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
     * "A newer tag exists, and here is what moving to it buys."
     *
     * @route GET /api/images/:id/upgrade
     *
     * Ownership is checked before anything is computed. The recommendation
     * itself is org-scoped too — candidate tags come from
     * `workload_containers` — so this is belt and braces, and both are wanted
     * on the one endpoint that reads another image's findings.
     */
    async getUpgrade(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { imageId: id });

            const visible = await time("orgRunsImage", orgRunsImage(orgId, id));
            if (!visible) {
                throw new AppError(404, "Image not found");
            }

            res.json(await time("recommendForImage", recommendForImage(orgId, id)));
        } catch (error) {
            next(error);
        }
    },

    /**
     * "Rebuilding on a newer base removes N of the M findings in your base
     * image." Null when the image's base is not known; otherwise the
     * recommendation or the stated reason there is none — the same
     * vocabulary `GET /:id/upgrade` answers in. Advice only.
     *
     * @route GET /api/images/:id/base-upgrade
     */
    async getBaseUpgrade(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { imageId: id });

            const visible = await time("orgRunsImage", orgRunsImage(orgId, id));
            if (!visible) {
                throw new AppError(404, "Image not found");
            }

            res.json({ recommendation: await time("baseUpgradeForImage", baseUpgradeForImage(orgId, id)) });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Every image in the org with a recommendation, ordered by how much risk
     * the move removes.
     *
     * @route GET /api/images/upgrades
     *
     * The bulk-fix screen. Forty workloads running six images is six actions,
     * and ordering by risk removed rather than by findings cleared is what
     * makes the first row the right one to do first.
     */
    async getUpgrades(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;

            const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
            const time = createQueryTimer(log, { orgId });
            res.json(await time("recommendationsForOrg", recommendationsForOrg(orgId, limit)));
        } catch (error) {
            next(error);
        }
    },
};

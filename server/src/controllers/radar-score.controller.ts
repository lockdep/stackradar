import type { Request, Response, NextFunction } from "express";
import { radarScoreRepository } from "../repositories/index.js";
import { parseTierParam } from "../db/finding-tier.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import {
    clusterRadarScoreQuerySchema,
    clusterRadarScoreFindingsQuerySchema,
    topFindingsQuerySchema,
} from "../schemas/cluster.schema.js";

const log = createLogger("radar-score.controller");

/** The Dashboard's "Start here" block asks for this many rows by default. */
const DEFAULT_TOP_FINDINGS = 10;

/**
 * The org-wide Radar Score, taken apart — the cluster tab's two handlers
 * (`cluster.controller.ts` `radarScore` / `radarScoreFindings`) with the
 * caller's org for a scope, plus the finding-level top-N the Dashboard's
 * "Start here" block reads. Same query parameters and response shapes as the
 * cluster routes, so the client renders both breakdowns with one component.
 */
export const radarScoreController = {
    /**
     * Every scanned image across the org's clusters, largest share first.
     * `total` is the org's current Radar Score — the Dashboard card's latest
     * point, computed live rather than from the hourly snapshot.
     *
     * @route GET /api/radar-score
     */
    async images(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const query = clusterRadarScoreQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });

            const page = await time(
                "findOrgRadarScoreImages",
                radarScoreRepository.findImages({ orgId }, { limit: query.limit, offset: query.offset, control: query.control }),
            );

            res.json(page);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The findings that add up to one image's share — the expand-row fetch.
     * The org scope is on the query, so another org's image id yields `[]`.
     *
     * @route GET /api/radar-score/findings
     */
    async findings(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const query = clusterRadarScoreFindingsQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });

            const result = await time(
                "findOrgRadarScoreFindings",
                radarScoreRepository.findImageFindings({ orgId }, query.imageId, parseTierParam(query.tier)),
            );

            res.json(result);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The findings to fix first across every cluster: exploited first, then
     * by contribution, each with the image and cluster it runs in.
     *
     * @route GET /api/radar-score/top-findings
     */
    async topFindings(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const query = topFindingsQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });

            const result = await time(
                "findOrgTopFindings",
                radarScoreRepository.findTopFindings(
                    { orgId },
                    query.limit ?? DEFAULT_TOP_FINDINGS,
                    parseTierParam(query.tier),
                ),
            );

            res.json(result);
        } catch (error) {
            next(error);
        }
    },
};

import type { Request, Response, NextFunction } from "express";
import { riskScoreRepository } from "../repositories/index.js";
import { parseTierParam } from "../db/finding-tier.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { clusterRiskScoreQuerySchema, clusterRiskScoreFindingsQuerySchema } from "../schemas/cluster.schema.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("risk-score.controller");

/**
 * The org-wide Risk Score, taken apart — the cluster tab's two handlers
 * (`cluster.controller.ts` `riskScore` / `riskScoreFindings`) with the
 * caller's org for a scope. Same query parameters and response shapes as the
 * cluster routes, so the client renders both breakdowns with one component.
 * The finding-level top-N the weekly digest's "Start here" rows draw from is
 * `riskScoreRepository.findTopFindings`, read by
 * `cloud/alerting/digest.service.ts` directly; it has no route.
 */
export const riskScoreController = {
    /**
     * Every scanned image across the org's clusters, largest share first.
     * `total` is the org's current Risk Score — the Dashboard card's latest
     * point, computed live rather than from the hourly snapshot.
     *
     * @route GET /api/risk-score
     */
    async images(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const query = clusterRiskScoreQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });

            const page = await time(
                "findOrgRiskScoreImages",
                riskScoreRepository.findImages(
                    { orgId },
                    { limit: query.limit, offset: query.offset, control: query.control },
                ),
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
     * @route GET /api/risk-score/findings
     */
    async findings(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            const query = clusterRiskScoreFindingsQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });

            const result = await time(
                "findOrgRiskScoreFindings",
                riskScoreRepository.findImageFindings({ orgId }, query.imageId, parseTierParam(query.tier)),
            );

            res.json(result);
        } catch (error) {
            next(error);
        }
    },
};

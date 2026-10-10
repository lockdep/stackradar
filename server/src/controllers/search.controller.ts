import type { Request, Response, NextFunction } from "express";
import { parseTierParam } from "../db/finding-tier.js";
import { searchRepository } from "../repositories/search.repository.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { searchQuerySchema } from "../schemas/search.schema.js";

const log = createLogger("search.controller");

export const searchController = {
    /**
     * The global palette's one request: top matches across vulnerabilities,
     * packages, images, workloads and clusters in the caller's org, grouped
     * and ranked by what the term looks like.
     *
     * Logs carry the org and the term's length, never the term — it may be a
     * customer's internal hostname or namespace.
     *
     * @route GET /api/search
     */
    async search(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const { q, limit, tier } = searchQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId, queryLength: q.length });

            const result = await time("search", searchRepository.search(orgId, q, limit, time, parseTierParam(tier)));

            res.json(result);
        } catch (error) {
            next(error);
        }
    },
};

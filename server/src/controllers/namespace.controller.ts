import type { Request, Response, NextFunction } from "express";
import { namespaceRepository } from "../repositories/index.js";
import { clusterScopeQuerySchema } from "../schemas/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { asAuthed } from "../middleware/auth.js";

const log = createLogger("namespace-controller");

/**
 * The folder view, preserved.
 *
 * Browsing by namespace survives the cutover — it is the mental model people
 * actually have of a cluster. What changed is that it is a `namespaces` row
 * with its workloads beneath it rather than a `type: "group"` row with a
 * `parentId`, so listing it is a plain join instead of a recursive tree walk,
 * and a namespace with **zero** scanned workloads is representable at all.
 */
export const namespaceController = {
    /**
     * @route GET /api/namespaces?clusterId={uuid}
     */
    async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;

            const { clusterId } = clusterScopeQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId, clusterId });
            const namespaces = await time("findAllWithCounts", namespaceRepository.findAllWithCounts(orgId, clusterId));
            res.json(namespaces);
        } catch (error) {
            next(error);
        }
    },
};

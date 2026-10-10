import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { namespaceRepository } from "../repositories/index.js";
import { clusterScopeQuerySchema, namespaceIdParamSchema } from "../schemas/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

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
            const orgId = req.auth!.orgId;

            const { clusterId } = clusterScopeQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId, clusterId });
            const namespaces = await time(
                "findAllWithCounts",
                namespaceRepository.findAllWithCounts(orgId, clusterId)
            );
            res.json(namespaces);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/namespaces/:id
     */
    async getById(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = namespaceIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { namespaceId: id });

            const namespace = await time("findById", namespaceRepository.findById(id));
            if (!namespace || namespace.orgId !== orgId) {
                throw new AppError(404, "Namespace not found");
            }
            res.json(namespace);
        } catch (error) {
            next(error);
        }
    },
};

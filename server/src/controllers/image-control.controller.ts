import type { Request, Response, NextFunction } from "express";
import { assertAdminOrOwner } from "../middleware/auth.js";
import { imageControlRulesSchema } from "../schemas/image-control.schema.js";
import { applyControlRules, describeImageRepositories } from "../services/image-control.service.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

const log = createLogger("image-control.controller");

/**
 * Who controls the org's image repositories — the confirm-once prompt on the
 * Dashboard and the Image ownership settings tab. Admin/owner only, both
 * ways: the list names every repository the org runs, and the answer changes
 * what every member is recommended.
 */
export const imageControlController = {
    /** @route GET /api/organizations/:id/image-control */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.params["id"]!;
            await assertAdminOrOwner(req, orgId);
            const time = createQueryTimer(log, { orgId });

            const repositories = await time("describeImageRepositories", describeImageRepositories(orgId));
            res.json({
                repositories,
                /** Repositories nothing has decided — what keeps the prompt on the Dashboard. */
                unknownCount: repositories.filter((r) => r.control === "unknown").length,
            });
        } catch (error) {
            next(error);
        }
    },

    /** @route PUT /api/organizations/:id/image-control-rules */
    async putRules(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.params["id"]!;
            await assertAdminOrOwner(req, orgId);
            const { rules } = imageControlRulesSchema.parse(req.body);
            const time = createQueryTimer(log, { orgId });

            const changed = await time(
                "applyControlRules",
                applyControlRules(
                    orgId,
                    { userId: req.auth?.userId ?? null, email: req.auth?.user?.email ?? null },
                    rules.map((r) => ({
                        registry: r.registry ?? null,
                        repository: r.repository,
                        control: r.control,
                        reason: r.reason,
                    })),
                ),
            );
            log.info({ orgId, changed }, "Image control rules updated");

            const repositories = await describeImageRepositories(orgId);
            res.json({
                changed,
                repositories,
                unknownCount: repositories.filter((r) => r.control === "unknown").length,
            });
        } catch (error) {
            next(error);
        }
    },
};

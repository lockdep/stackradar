import type { Request, Response, NextFunction } from "express";
import { assertAdminOrOwner } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { imageControlRulesSchema } from "../schemas/image-control.schema.js";
import { applyControlRules, describeImageRepositories } from "../services/image-control.service.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

const log = createLogger("image-control.controller");

/**
 * The read gate: admin or owner of the org, or any member of the **demo**
 * org. One membership read answers both (`getMembership` returns the role
 * and the org row); `assertAdminOrOwner` is not reused here because it would
 * cost a second query for the role this call already holds. No membership
 * at all is a 403 whatever the org: this router mounts no `requireOrg`, so
 * this is the only membership check on the path.
 */
async function assertMayList(req: Request, orgId: string): Promise<void> {
    const userId = req.auth?.userId;
    const membership = userId ? await organizationRepository.getMembership(orgId, userId) : null;
    if (!membership) throw new AppError(403, "Admin or owner role required");
    if (membership.org.demo) return;
    if (!organizationRepository.isAdminOrOwner(membership.role)) {
        throw new AppError(403, "Admin or owner role required");
    }
}

/**
 * Who controls the org's image repositories — the confirm-once prompt on the
 * Dashboard and the Image ownership settings tab. Admin/owner only, both
 * ways: the list names every repository the org runs, and the answer changes
 * what every member is recommended.
 *
 * One exception on the read: a member of the **demo** org
 * (`organizations.demo`) may list. The live demo renders the Dashboard's
 * ownership banner with the demo org's answers and no way to change them
 * (client `ImageOwnershipBanner`), and the demo visitor is a member, so until
 * 2026-11-01 every demo visit logged a 403 on this route (the 1 Nov 2026
 * audit). `putRules` keeps the plain admin/owner assertion, and `requireAuth`
 * refuses every non-read method for a demo user anyway.
 */
export const imageControlController = {
    /** @route GET /api/organizations/:id/image-control */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.params["id"]!;
            await assertMayList(req, orgId);
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

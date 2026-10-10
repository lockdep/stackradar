import type { Request, Response, NextFunction } from "express";
import { assertAdminOrOwner } from "../middleware/auth.js";
import { createTierRuleSchema, tierRuleIdParamSchema } from "../schemas/tier-rules.schema.js";
import { addTierRule, listTierRules, removeTierRule } from "../services/tier-rules.service.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

const log = createLogger("tier-rules.controller");

const actorOf = (req: Request) => ({ userId: req.auth?.userId ?? null, email: req.auth?.user?.email ?? null });

/**
 * An org's override rules for which packages count as "Application" and
 * which as "Base image" (component tier plan, item 9). Admin/owner only:
 * a rule changes what every member's findings tables show first.
 */
export const tierRulesController = {
    /** @route GET /api/organizations/:id/tier-rules */
    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.params["id"]!;
            await assertAdminOrOwner(req, orgId);
            const time = createQueryTimer(log, { orgId });
            res.json({ rules: await time("listTierRules", listTierRules(orgId)) });
        } catch (error) {
            next(error);
        }
    },

    /** @route POST /api/organizations/:id/tier-rules */
    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.params["id"]!;
            await assertAdminOrOwner(req, orgId);
            const input = createTierRuleSchema.parse(req.body);
            const rule = await addTierRule(orgId, actorOf(req), input);
            // 202-shaped in spirit: the rule exists now, the views follow when the job has run.
            res.status(201).json({ rule, reclassifying: true });
        } catch (error) {
            next(error);
        }
    },

    /** @route DELETE /api/organizations/:id/tier-rules/:ruleId */
    async remove(req: Request, res: Response, next: NextFunction) {
        try {
            const { id: orgId, ruleId } = tierRuleIdParamSchema.parse(req.params);
            await assertAdminOrOwner(req, orgId);
            await removeTierRule(orgId, actorOf(req), ruleId);
            res.status(204).end();
        } catch (error) {
            next(error);
        }
    },
};

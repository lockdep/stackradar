import { z } from "zod";
import { ASSIGNABLE_TIERS, TIER_RULE_KINDS } from "../lib/component-tier.js";

/** `POST /api/organizations/:id/tier-rules` */
export const createTierRuleSchema = z.object({
    matchKind: z.enum(TIER_RULE_KINDS),
    /**
     * A literal prefix (or, for `name`, the whole package name). At least
     * three characters: a one-letter prefix is a rule about everything.
     */
    pattern: z.string().trim().min(3).max(512),
    tier: z.enum(ASSIGNABLE_TIERS),
    reason: z.string().trim().max(500).nullable().optional(),
});

export const tierRuleIdParamSchema = z.object({ id: z.uuid(), ruleId: z.uuid() });

/**
 * An org's override rules for the component classifier (component tier plan,
 * item 9): list them with what they touch, add, remove, and re-run the
 * classifier over that org — and only that org — when they change.
 *
 * A rule moves components between the findings lens's buckets. It is not
 * suppression and does not pretend to be: the findings are still counted,
 * still scored, still under All, and still shown anywhere when exploited.
 * Suppression stays where it is (`finding_states`), manual, with an owner, a
 * reason and an expiry.
 *
 * The reclassification is a `tier_reclassify` job rather than part of the
 * request: an org can hold hundreds of thousands of components, and the
 * classifier is TypeScript, so the pass is batches of reads and updates.
 * One queued job per org at a time is enough — it reads the rules when it
 * *runs*, so two quick edits are one pass.
 */

import { and, eq, sql } from "drizzle-orm";
import type postgres from "postgres";
import { db, schema } from "../db/index.js";
import { backfillComponentTier, type TierBackfillResult } from "../lib/component-tier-backfill.js";
import type { AssignableTier, TierRuleKind } from "../lib/component-tier.js";
import type { ComponentTierRule } from "../db/schema/component-tier-rules.js";
import { AppError } from "../middleware/error-handler.js";
import { isUniqueViolationOn } from "../lib/pg-errors.js";
import { jobRepository } from "../repositories/job.repository.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tier-rules");

/** An org's rule list stays short enough to read, and to apply per component. */
export const MAX_TIER_RULES = 100;

export interface TierRuleView extends ComponentTierRule {
    /** Components of the org's images the rule currently matches. */
    componentsTouched: number;
}

/** How many of the org's components a rule matches — the same three comparisons `applyTierRules` makes. */
async function componentsTouched(orgId: string, rule: { matchKind: TierRuleKind; pattern: string }): Promise<number> {
    // `starts_with` / `=`: literal, so a `%` or `_` in a pattern is just a character.
    const match =
        rule.matchKind === "purl-prefix"
            ? sql`starts_with(c.purl, ${rule.pattern})`
            : rule.matchKind === "name"
              ? sql`c.name = ${rule.pattern}`
              : sql`EXISTS (
                        SELECT 1 FROM component_properties p
                         WHERE p.component_id = c.id
                           AND p.name = 'syft:location:0:path'
                           AND starts_with(p.value, ${rule.pattern})
                    )`;
    const rows = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
          FROM components c
          JOIN sboms s ON s.id = c.sbom_id
          JOIN images i ON i.id = s.image_id
         WHERE i.org_id = ${orgId} AND ${match}
    `);
    return Number(rows[0]?.n ?? 0);
}

export async function listTierRules(orgId: string): Promise<TierRuleView[]> {
    const rules = await db
        .select()
        .from(schema.componentTierRules)
        .where(eq(schema.componentTierRules.orgId, orgId))
        .orderBy(schema.componentTierRules.createdAt);
    return Promise.all(rules.map(async (rule) => ({ ...rule, componentsTouched: await componentsTouched(orgId, rule) })));
}

async function queueReclassify(orgId: string): Promise<void> {
    // Only a job that has not started yet covers this change: one already
    // running read the rules before it, and would finish with the old set.
    const [pending] = await db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.orgId, orgId), eq(schema.jobs.type, "tier_reclassify"), eq(schema.jobs.status, "pending")))
        .limit(1);
    if (pending) return;
    await jobRepository.create({
        orgId,
        type: "tier_reclassify",
        title: "Reclassify packages after a rule change",
        triggeredBy: "manual",
        priority: 3,
        params: { orgId },
    });
}

export async function addTierRule(
    orgId: string,
    actor: { userId: string | null; email: string | null },
    input: { matchKind: TierRuleKind; pattern: string; tier: AssignableTier; reason?: string | null | undefined }
): Promise<TierRuleView> {
    const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.componentTierRules)
        .where(eq(schema.componentTierRules.orgId, orgId));
    if (n >= MAX_TIER_RULES) throw new AppError(409, `An organization can have at most ${MAX_TIER_RULES} rules`);

    let rule: ComponentTierRule;
    try {
        rule = await db.transaction(async (tx) => {
            const [created] = await tx
                .insert(schema.componentTierRules)
                .values({
                    orgId,
                    matchKind: input.matchKind,
                    pattern: input.pattern,
                    tier: input.tier,
                    reason: input.reason ?? null,
                    createdBy: actor.userId,
                    createdByEmail: actor.email,
                })
                .returning();
            await tx.insert(schema.activityEvents).values({
                orgId,
                type: "tier-rule.created",
                payload: { ruleId: created!.id, matchKind: input.matchKind, pattern: input.pattern, tier: input.tier, reason: input.reason ?? null, byUserId: actor.userId, byEmail: actor.email },
            });
            return created!;
        });
    } catch (error) {
        if (isUniqueViolationOn(error, "component_tier_rules_org_kind_pattern_unique")) {
            throw new AppError(409, "A rule with this pattern already exists");
        }
        throw error;
    }

    await queueReclassify(orgId);
    log.info({ orgId, ruleId: rule.id, matchKind: rule.matchKind }, "Tier rule added");
    return { ...rule, componentsTouched: await componentsTouched(orgId, rule) };
}

export async function removeTierRule(orgId: string, actor: { userId: string | null; email: string | null }, ruleId: string): Promise<void> {
    const removed = await db.transaction(async (tx) => {
        const [rule] = await tx
            .delete(schema.componentTierRules)
            .where(and(eq(schema.componentTierRules.id, ruleId), eq(schema.componentTierRules.orgId, orgId)))
            .returning();
        if (!rule) return null;
        await tx.insert(schema.activityEvents).values({
            orgId,
            type: "tier-rule.removed",
            payload: { ruleId, matchKind: rule.matchKind, pattern: rule.pattern, tier: rule.tier, byUserId: actor.userId, byEmail: actor.email },
        });
        return rule;
    });
    if (!removed) throw new AppError(404, "Rule not found");

    await queueReclassify(orgId);
    log.info({ orgId, ruleId }, "Tier rule removed");
}

/** The org's rules in the shape the classifier takes — what the SBOM ingest loads. */
export async function tierRulesForOrg(orgId: string) {
    const rows = await db
        .select({
            matchKind: schema.componentTierRules.matchKind,
            pattern: schema.componentTierRules.pattern,
            tier: schema.componentTierRules.tier,
        })
        .from(schema.componentTierRules)
        .where(eq(schema.componentTierRules.orgId, orgId));
    return rows;
}

/** The `tier_reclassify` job: every component of the org, built-in rules then the org's. */
export async function runTierReclassifyJob(orgId: string): Promise<Record<string, unknown>> {
    // The backfill core speaks postgres-js; drizzle hands its client over.
    const client = (db as unknown as { $client: postgres.Sql }).$client;
    const result: TierBackfillResult = await backfillComponentTier(client, { orgId });
    log.info({ orgId, ...result }, "Reclassified an organization's packages");
    return { ...result };
}

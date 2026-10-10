import type { Request, Response, NextFunction } from "express";
import { parseTierParam } from "../db/finding-tier.js";
import { groupedFindingsQuerySchema } from "../schemas/cluster.schema.js";
import { AppError } from "../middleware/error-handler.js";
import { orgRunsImage } from "../db/tenancy.js";
import {
    createIssue,
    effectiveState,
    fixRollupForOrg,
    fixesForOrg,
    imageRemediationDetail,
    issueDetail,
    listIssues,
    removeFindingState,
    suppressFinding,
    transitionIssue,
    type Actor,
    type IssueTransition,
} from "../services/remediation.service.js";
import { remediationRepository } from "../repositories/index.js";
import {
    issueIdParamSchema,
    rollupQuerySchema,
    activityQuerySchema,
    createIssueSchema,
    findingStateIdParamSchema,
    imageIdParamSchema,
    listIssuesQuerySchema,
    suppressFindingSchema,
    transitionIssueSchema,
} from "../schemas/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

const log = createLogger("remediation-controller");

/**
 * The Fix tab — docs/proposals/remediation-workflow.md and
 * docs/proposals/issues-workflow.md.
 *
 * One row per image, because that is the unit anyone can change; the issue
 * lifecycle around it; suppression with owner/reason/expiry; and the
 * activity feed. Nothing here implies an upgrade is safe — the copy states
 * what a move clears, what it leaves, and stops.
 */

function actorFrom(req: Request): Actor {
    const auth = req.auth!;
    return { userId: auth.userId ?? "", email: auth.user?.email ?? "" };
}

export const remediationController = {
    /**
     * @route GET /api/remediation/rollup?cluster=<id>
     */
    async getRollup(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const { cluster } = rollupQuerySchema.parse(req.query);
            const time = createQueryTimer(log, { orgId });
            const rollup = await time("fixRollupForOrg", fixRollupForOrg(orgId, cluster ?? null));
            res.json(rollup);
        } catch (error) {
            next(error);
        }
    },

    /**
     * The Fixes page: every move the product can recommend across the org,
     * ranked, plus the images with findings it has no move for and why.
     * Read-only by construction — nothing here applies anything.
     *
     * @route GET /api/remediation/fixes
     */
    async getFixes(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { orgId });
            const page = await time("fixesForOrg", fixesForOrg(orgId));
            res.json(page);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/remediation/images/:id
     */
    async getImageDetail(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = imageIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { imageId: id });

            const visible = await time("orgRunsImage", orgRunsImage(orgId, id));
            if (!visible) {
                throw new AppError(404, "Image not found");
            }

            const { tier } = groupedFindingsQuerySchema.parse(req.query);
            const detail = await time(
                "imageRemediationDetail",
                imageRemediationDetail(orgId, id, parseTierParam(tier)),
            );
            res.json(detail);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/remediation/issues?state=<state>&cluster=<id>
     */
    async getIssues(req: Request, res: Response, next: NextFunction) {
        try {
            const orgId = req.auth!.orgId;
            const { state, cluster } = listIssuesQuerySchema.parse(req.query);
            const issues = await listIssues(orgId, {
                ...(state != null ? { state } : {}),
                ...(cluster != null ? { clusterId: cluster } : {}),
            });
            res.json(issues);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/remediation/issues/:id
     */
    async getIssueDetail(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = issueIdParamSchema.parse(req.params);
            const detail = await issueDetail(req.auth!.orgId, id);
            res.json(detail);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route POST /api/remediation/issues
     */
    async createIssue(req: Request, res: Response, next: NextFunction) {
        try {
            const input = createIssueSchema.parse(req.body);
            const issue = await createIssue(req.auth!.orgId, actorFrom(req), input);
            res.status(201).json({ ...issue, effectiveState: effectiveState(issue) });
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route PATCH /api/remediation/issues/:id
     */
    async transitionIssue(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = issueIdParamSchema.parse(req.params);
            const input = transitionIssueSchema.parse(req.body);
            const transition: IssueTransition =
                input.state === "snoozed"
                    ? { to: "snoozed", snoozedUntil: input.snoozedUntil! }
                    : input.state === "closed"
                      ? {
                            to: "closed",
                            closedReason: input.closedReason!,
                            closedNote: input.closedNote ?? null,
                            actor: actorFrom(req),
                        }
                      : { to: input.state };
            const issue = await transitionIssue(req.auth!.orgId, id, transition);
            res.json({ ...issue, effectiveState: effectiveState(issue) });
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/remediation/suppressions
     */
    async getSuppressions(req: Request, res: Response, next: NextFunction) {
        try {
            const states = await remediationRepository.listFindingStates(req.auth!.orgId);
            res.json(states);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route POST /api/remediation/suppressions
     */
    async createSuppression(req: Request, res: Response, next: NextFunction) {
        try {
            const input = suppressFindingSchema.parse(req.body);
            const actor = actorFrom(req);
            if (!actor.userId || !actor.email) {
                // The schema mandates reason and expiry; the third leg —
                // an attributable owner — comes from the auth context.
                throw new AppError(400, "Suppression requires an attributable user");
            }
            const state = await suppressFinding(req.auth!.orgId, actor, input);
            res.status(201).json(state);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route DELETE /api/remediation/suppressions/:id
     */
    async deleteSuppression(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = findingStateIdParamSchema.parse(req.params);
            const removed = await removeFindingState(req.auth!.orgId, actorFrom(req), id);
            res.json(removed);
        } catch (error) {
            next(error);
        }
    },

    /**
     * @route GET /api/remediation/activity
     */
    async getActivity(req: Request, res: Response, next: NextFunction) {
        try {
            const { limit } = activityQuerySchema.parse(req.query);
            const events = await remediationRepository.listEvents(req.auth!.orgId, limit);
            res.json(events);
        } catch (error) {
            next(error);
        }
    },
};

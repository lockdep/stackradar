import type { Request, Response, NextFunction } from "express";
import { planHasAlerts } from "../config/plans.js";
import { createLogger } from "../lib/logger.js";
import { validateWebhookUrl } from "../lib/slack-webhook.js";
import { cloudHooks } from "../lib/cloud-hooks.js";
import { AppError } from "../middleware/error-handler.js";
import { assertAdminOrOwner } from "../middleware/auth.js";
import { alertRepository, organizationRepository } from "../repositories/index.js";
import { alertService } from "../services/alert.service.js";
import { updateAlertsSchema } from "../schemas/index.js";
import type { AlertOrg } from "../repositories/alert.repository.js";

const log = createLogger("alerts.controller");

/** 403 with a code the client branches on to draw the upgrade prompt. */
const PLAN_REQUIRED = new AppError(
    403,
    "Critical & KEV alerts are included in Pro and Business",
    true,
    "PLAN_REQUIRED",
);

async function loadOrg(orgId: string): Promise<AlertOrg> {
    const org = await organizationRepository.getOrganizationById(orgId);
    if (!org) throw new AppError(404, "Organization not found");
    return {
        id: org.id,
        name: org.name,
        plan: org.plan,
        alertEmailEnabled: org.alertEmailEnabled,
        alertSlackWebhookUrl: org.alertSlackWebhookUrl,
        alertMinSeverity: org.alertMinSeverity,
        alertKev: org.alertKev,
        alertsCursorAt: org.alertsCursorAt,
    };
}

/**
 * The critical & KEV alert settings — `services/alert.service.ts`. Owners
 * and admins only, like every organisation setting. Reads work on every
 * plan (the page has to explain what Pro buys); writes and the test send
 * answer `403 PLAN_REQUIRED` on a plan without alerts, so a free org cannot
 * be left with a webhook that never fires. The email channel and its
 * recipients exist only where the cloud registered them (`cloudHooks`);
 * the unsubscribe link that switches it off is the cloud's route.
 */
export const alertsController = {
    /** @route GET /api/organizations/:id/alerts */
    async get(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            await assertAdminOrOwner(req, id);
            const org = await loadOrg(id);
            const [recipients, sends] = await Promise.all([
                cloudHooks.alertEmail?.recipients(org.id) ?? Promise.resolve([]),
                alertRepository.listRecentSends(org.id, 10),
            ]);
            res.json({
                ...alertService.settingsView(org),
                recipients,
                recentSends: sends.map((s) => ({
                    id: s.id,
                    channel: s.channel,
                    recipient: s.recipient,
                    subject: s.subject,
                    advisoryCount: s.advisoryCount,
                    kind: s.kind,
                    status: s.status,
                    error: s.error,
                    sentAt: s.sentAt,
                })),
            });
        } catch (error) {
            next(error);
        }
    },

    /** @route PATCH /api/organizations/:id/alerts */
    async update(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            await assertAdminOrOwner(req, id);
            const data = updateAlertsSchema.parse(req.body);
            if (Object.values(data).every((v) => v === undefined)) {
                throw new AppError(400, "No fields to update");
            }
            const org = await loadOrg(id);
            if (!planHasAlerts(org.plan)) throw PLAN_REQUIRED;

            // Both criteria off would be a message that can never be sent;
            // switching the channels off is how alerts are switched off.
            const minSeverity = data.minSeverity ?? org.alertMinSeverity;
            const kev = data.kev ?? org.alertKev;
            if (minSeverity === "none" && !kev) {
                throw new AppError(
                    400,
                    "Choose a severity or known-exploited findings, or switch the channel off instead",
                );
            }

            let slackWebhookUrl: string | null | undefined = undefined;
            if (data.slackWebhookUrl !== undefined) {
                if (data.slackWebhookUrl === null || data.slackWebhookUrl === "") {
                    slackWebhookUrl = null;
                } else {
                    const verdict = validateWebhookUrl(data.slackWebhookUrl);
                    if (!verdict.ok) throw new AppError(400, verdict.error);
                    slackWebhookUrl = verdict.url;
                }
            }

            const updated = await alertRepository.updateSettings(org.id, {
                alertEmailEnabled: data.emailEnabled,
                alertSlackWebhookUrl: slackWebhookUrl,
                alertMinSeverity: data.minSeverity,
                alertKev: data.kev,
            });
            if (!updated) throw new AppError(404, "Organization not found");

            log.info(
                {
                    orgId: org.id,
                    emailEnabled: updated.alertEmailEnabled,
                    slack: updated.alertSlackWebhookUrl != null,
                    minSeverity: updated.alertMinSeverity,
                    kev: updated.alertKev,
                    userId: req.auth?.userId,
                },
                "Alert settings updated",
            );
            res.json(alertService.settingsView(updated));
        } catch (error) {
            next(error);
        }
    },

    /** @route POST /api/organizations/:id/alerts/test */
    async test(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            await assertAdminOrOwner(req, id);
            const org = await loadOrg(id);
            if (!planHasAlerts(org.plan)) throw PLAN_REQUIRED;
            const emailOn = org.alertEmailEnabled && cloudHooks.alertEmail != null;
            if (!emailOn && !org.alertSlackWebhookUrl) {
                throw new AppError(
                    400,
                    cloudHooks.alertEmail ? "Switch on email or add a webhook first" : "Add a webhook first",
                );
            }
            if (req.auth?.type !== "internal") throw new AppError(403, "A signed-in user is required");
            const result = await alertService.sendTest(org, { id: req.auth.userId, email: req.auth.user.email });
            res.json(result);
        } catch (error) {
            next(error);
        }
    },
};

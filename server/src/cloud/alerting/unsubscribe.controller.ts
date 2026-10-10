// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { verifyUnsubscribeToken } from "./unsubscribe-token.js";
import { digestService } from "./digest.service.js";
import { escapeHtml } from "../email/layout.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { alertRepository } from "../../repositories/alert.repository.js";

const log = createLogger("unsubscribe.controller");

const querySchema = z.object({ token: z.string().min(1).max(400) });

function unsubscribePage(title: string, body: string, status: number, res: Response): void {
    res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} — StackRadar</title></head><body style="margin:0;padding:48px 16px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;"><p style="font-size:18px;font-weight:600;margin:0 0 16px;">StackRadar</p><h1 style="font-size:20px;margin:0 0 12px;">${escapeHtml(title)}</h1><p style="font-size:15px;line-height:1.6;margin:0;">${body}</p></div></body></html>`);
}

/**
 * The unsubscribe links in the weekly digest and the alert email. Public
 * (`/v1`) and unauthenticated: the token is the credential
 * (`unsubscribe-token.ts`), and it can only switch one org's one email
 * kind off. GET, because it is clicked from a mail client; a mail scanner
 * pre-fetching the link switches the mail off, which is the failure
 * direction an unsubscribe should have. POST too, for the mail client's
 * one-click button (RFC 8058, `List-Unsubscribe-Post`).
 */
export const unsubscribeController = {
    /** @route GET|POST /v1/digest/unsubscribe?token= */
    async digest(req: Request, res: Response, next: NextFunction) {
        try {
            const parsed = querySchema.safeParse(req.query);
            const orgId = parsed.success ? verifyUnsubscribeToken("digest", parsed.data.token) : null;
            if (!orgId) {
                unsubscribePage("This link is not valid", "The unsubscribe link is incomplete or has been altered. Open a recent digest email and use the link at the bottom, or switch the weekly digest off under Organization settings.", 400, res);
                return;
            }
            const ok = await digestService.unsubscribe(orgId);
            if (!ok) {
                unsubscribePage("Nothing to switch off", "The organisation this link belongs to no longer exists.", 404, res);
                return;
            }
            unsubscribePage(
                "Weekly digest switched off",
                `Your organisation will not receive the weekly StackRadar digest. An owner or admin can turn it back on under <a href="${escapeHtml(`${config.appUrl}/org-settings?tab=notifications`)}" style="color:#2563eb;">Organization settings</a>.`,
                200,
                res,
            );
        } catch (error) {
            next(error);
        }
    },

    /**
     * The alert email's link: the email channel off, the webhook untouched.
     * @route GET|POST /v1/alerts/unsubscribe?token=
     */
    async alerts(req: Request, res: Response, next: NextFunction) {
        try {
            const parsed = querySchema.safeParse(req.query);
            const orgId = parsed.success ? verifyUnsubscribeToken("alerts", parsed.data.token) : null;
            if (!orgId) {
                unsubscribePage("This link is not valid", "The unsubscribe link is incomplete or has been altered. Open a recent alert email and use the link at the bottom, or switch alert email off under Organization settings → Notifications.", 400, res);
                return;
            }
            const ok = await alertRepository.setEmailEnabled(orgId, false);
            if (!ok) {
                unsubscribePage("Nothing to switch off", "The organisation this link belongs to no longer exists.", 404, res);
                return;
            }
            log.info({ orgId }, "Alert email switched off via unsubscribe link");
            unsubscribePage(
                "Alert email switched off",
                `Your organisation will not receive critical &amp; KEV alerts by email. A webhook, if one is set, keeps posting. An owner or admin can turn email back on under <a href="${escapeHtml(`${config.appUrl}/org-settings?tab=notifications`)}" style="color:#2563eb;">Organization settings → Notifications</a>.`,
                200,
                res
            );
        } catch (error) {
            next(error);
        }
    },
};

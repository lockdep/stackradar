// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { verifyResendWebhook } from "./resend-webhook.js";
import { alertRepository, inviteRepository } from "../../repositories/index.js";
import { digestRepository } from "../alerting/digest.repository.js";
import type { InviteEmailStatus } from "../../db/schema/index.js";

const log = createLogger("email.controller");

/**
 * Resend event types → the status they map to, on invites and on digest
 * sends alike (`digest_sends.status` uses the same vocabulary). Events not
 * listed (sent, opened, clicked) are acknowledged and ignored: `sent` is
 * already recorded from the API response, and open/click tracking is off.
 */
const EVENT_STATUS: Record<string, InviteEmailStatus> = {
    "email.delivered": "delivered",
    "email.delivery_delayed": "delayed",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.failed": "failed",
};

const resendEventSchema = z.object({
    type: z.string(),
    created_at: z.string(),
    data: z.object({
        email_id: z.string(),
    }).loose(),
});

function header(req: Request, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

export const emailController = {
    /**
     * Resend delivery events
     * @route POST /v1/webhooks/resend
     * Raw body is preserved by app.ts (express.raw) for signature verification.
     */
    async resendWebhook(req: Request, res: Response, next: NextFunction) {
        try {
            if (!config.email.webhookSecret) {
                res.status(401).json({ error: "Webhook not configured" });
                return;
            }

            const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
            const verdict = verifyResendWebhook(config.email.webhookSecret, {
                id: header(req, "svix-id"),
                timestamp: header(req, "svix-timestamp"),
                signature: header(req, "svix-signature"),
            }, rawBody);

            if (!verdict.ok) {
                log.warn({ reason: verdict.reason }, "Rejected Resend webhook");
                res.status(400).json({ error: "Invalid signature" });
                return;
            }

            const parsed = resendEventSchema.safeParse(JSON.parse(rawBody));
            if (!parsed.success) {
                res.status(400).json({ error: "Malformed event" });
                return;
            }

            const event = parsed.data;
            const status = EVENT_STATUS[event.type];
            if (!status) {
                res.json({ received: true, handled: false });
                return;
            }

            const at = new Date(event.created_at);
            const when = Number.isNaN(at.getTime()) ? new Date() : at;
            /* A message id belongs to exactly one send; both lookups run so
               neither table needs to know which kind of mail it was. */
            const [inviteMatched, digestMatched, alertMatched] = await Promise.all([
                inviteRepository.applyEmailEvent(event.data.email_id, status, when),
                digestRepository.applyEmailEvent(event.data.email_id, status, when),
                alertRepository.applyEmailEvent(event.data.email_id, status, when),
            ]);
            const matched = inviteMatched || digestMatched || alertMatched;
            log.info({ type: event.type, messageId: event.data.email_id, matched, kind: inviteMatched ? "invite" : digestMatched ? "digest" : alertMatched ? "alert" : null }, "Resend event");
            res.json({ received: true, handled: matched });
        } catch (error) {
            next(error);
        }
    },
};

// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { alertSettingsUrl } from "../../lib/alert-message.js";
import type { AlertBatch } from "../../lib/alert-batch.js";
import type { AlertEmailChannel, ChannelOutcome } from "../../lib/cloud-hooks.js";
import { alertRepository, type AlertOrg } from "../../repositories/alert.repository.js";
import { emailService } from "../email/email.service.js";
import { digestRepository } from "./digest.repository.js";
import { listUnsubscribeHeaders, unsubscribeUrl } from "./unsubscribe-token.js";
import { renderAlertEmail, renderTestAlertEmail } from "./alert-email.js";

const log = createLogger("alert-email");

/**
 * The email half of the critical & KEV alerts, registered into the core's
 * alert pass through `cloudHooks.alertEmail` (`cloud/hooks.ts`). Email goes
 * to the same owners and admins the weekly digest does, one message each,
 * with the Resend idempotency key making a re-offered batch harmless and
 * the signed unsubscribe link in the footer.
 */
export const alertEmailChannel: AlertEmailChannel = {
    async deliver(org: AlertOrg, batch: AlertBatch, now: Date) {
        const stats = { sent: 0, failed: 0 };
        if (!emailService.isConfigured()) return stats;
        const clusterIds = [...new Set(batch.items.flatMap((i) => i.clusterIds))];
        const clusterNames = await alertRepository.findClusterNames(clusterIds);
        const unsubscribe = unsubscribeUrl("alerts", org.id);
        const mail = renderAlertEmail({
            orgName: org.name,
            items: batch.items,
            clusterNames,
            appUrl: config.appUrl,
            settingsUrl: alertSettingsUrl(),
            unsubscribeUrl: unsubscribe,
        });
        const batchKey = batch.eventIds[batch.eventIds.length - 1] ?? now.toISOString();
        const recipients = await digestRepository.findRecipients(org.id);
        for (const user of recipients) {
            const result = await emailService.send({
                ...mail,
                to: user.email,
                tags: { type: "critical_alert", org_id: org.id },
                idempotencyKey: `alert/${org.id}/${user.id}/${batchKey}`,
                headers: listUnsubscribeHeaders(unsubscribe),
            });
            if (result.status === "not_configured") continue;
            await alertRepository.recordSend({
                orgId: org.id,
                channel: "email",
                userId: user.id,
                recipient: user.email,
                subject: mail.subject,
                eventIds: batch.eventIds,
                advisoryCount: batch.items.length,
                kind: "alert",
                resendMessageId: result.status === "sent" ? result.messageId : null,
                status: result.status === "sent" ? "sent" : "failed",
                error: result.status === "failed" ? result.error.slice(0, 500) : null,
                sentAt: now,
                updatedAt: now,
            });
            if (result.status === "sent") stats.sent++;
            else stats.failed++;
        }
        if (stats.failed > 0) log.warn({ orgId: org.id, ...stats }, "Some alert emails were refused");
        return stats;
    },

    async sendTest(org: AlertOrg, requester: { id: string; email: string }, now: Date): Promise<ChannelOutcome> {
        if (!emailService.isConfigured()) {
            return { status: "failed", error: "Email is not configured on this server" };
        }
        const unsubscribe = unsubscribeUrl("alerts", org.id);
        const mail = renderTestAlertEmail({
            orgName: org.name,
            settingsUrl: alertSettingsUrl(),
            unsubscribeUrl: unsubscribe,
        });
        const result = await emailService.send({
            ...mail,
            to: requester.email,
            tags: { type: "critical_alert_test", org_id: org.id },
            headers: listUnsubscribeHeaders(unsubscribe),
        });
        await alertRepository.recordSend({
            orgId: org.id,
            channel: "email",
            userId: requester.id,
            recipient: requester.email,
            subject: mail.subject,
            eventIds: [],
            advisoryCount: 0,
            kind: "test",
            resendMessageId: result.status === "sent" ? result.messageId : null,
            status: result.status === "sent" ? "sent" : "failed",
            error: result.status === "failed" ? result.error.slice(0, 500) : null,
            sentAt: now,
            updatedAt: now,
        });
        return result.status === "sent"
            ? { status: "sent" }
            : { status: "failed", error: result.status === "failed" ? result.error : "not configured" };
    },

    async recipients(orgId: string) {
        const rows = await digestRepository.findRecipients(orgId);
        return rows.map((r) => ({ email: r.email, name: r.name }));
    },
};

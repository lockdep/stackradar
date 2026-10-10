// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import { postSlackWebhook } from "../../lib/slack-webhook.js";
import { emailService } from "../email/email.service.js";
import {
    renderClusterAlert,
    renderClusterAlertSlack,
    renderSignupAlert,
    renderSignupAlertSlack,
    type ClusterAlertInput,
    type SignupAlertInput,
} from "./founder-alert-email.js";

const log = logger.child({ module: "founder-alert" });

export type FounderAlertResult =
    | { status: "sent"; channels: Array<"email" | "slack"> }
    | { status: "not_configured" }
    | { status: "failed"; error: string };

/**
 * The founder alert: tell the operator, by email and/or Slack, the moment a
 * self-sign-up happens and the moment that org's first cluster reports in.
 * Strategy doc 2026-09-26 §3 P2 — a real sign-up must get a personal reply
 * within a day, and until now nothing said one had happened.
 *
 * Both channels are optional and independent. `sent` means at least one
 * channel accepted the message: the caller stamps the row on that, so a
 * broken Slack webhook next to a working mailbox does not re-alert on every
 * inventory report, and a channel that fails is logged where the other's
 * success is. Like the other side-effect senders (`emailService`,
 * `posthogService`), this never throws — setup and inventory ingest must
 * not fail because the founder's inbox did.
 *
 * The email's Reply-To is the sign-up's own address, so answering the alert
 * is answering the person.
 */
export const founderAlertService = {
    isConfigured(): boolean {
        return Boolean(
            (config.founderAlerts.email && emailService.isConfigured()) || config.founderAlerts.slackWebhookUrl
        );
    },

    async notifySignup(input: SignupAlertInput): Promise<FounderAlertResult> {
        return deliver("signup", input.org.id, {
            email: () => renderSignupAlert(input),
            slack: () => renderSignupAlertSlack(input),
            idempotencyKey: `founder-alert/signup/${input.org.id}`,
            replyTo: input.person.email,
        });
    },

    async notifyFirstCluster(input: ClusterAlertInput): Promise<FounderAlertResult> {
        return deliver("cluster", input.org.id, {
            email: () => renderClusterAlert(input),
            slack: () => renderClusterAlertSlack(input),
            idempotencyKey: `founder-alert/cluster/${input.org.id}`,
            replyTo: input.person.email,
        });
    },
};

async function deliver(
    kind: "signup" | "cluster",
    orgId: string,
    message: {
        email: () => { subject: string; html: string; text: string };
        slack: () => string;
        idempotencyKey: string;
        replyTo: string;
    }
): Promise<FounderAlertResult> {
    if (!founderAlertService.isConfigured()) {
        log.info({ kind, orgId }, "Founder alerts not configured — alert not sent");
        return { status: "not_configured" };
    }

    const channels: Array<"email" | "slack"> = [];
    const errors: string[] = [];

    if (config.founderAlerts.email && emailService.isConfigured()) {
        const result = await emailService.send({
            ...message.email(),
            to: config.founderAlerts.email,
            replyTo: message.replyTo,
            tags: { type: "founder_alert", kind },
            idempotencyKey: message.idempotencyKey,
        });
        if (result.status === "sent") channels.push("email");
        else if (result.status === "failed") errors.push(`email: ${result.error}`);
    }

    if (config.founderAlerts.slackWebhookUrl) {
        const result = await postSlackWebhook(config.founderAlerts.slackWebhookUrl, message.slack());
        if (result.status === "sent") channels.push("slack");
        else errors.push(`slack: ${result.error}`);
    }

    if (channels.length > 0) {
        log.info({ kind, orgId, channels, errors }, "Founder alert sent");
        return { status: "sent", channels };
    }
    const error = errors.join("; ") || "no channel accepted the alert";
    log.error({ kind, orgId, error }, "Founder alert failed");
    return { status: "failed", error };
}

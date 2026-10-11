// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import type { EmailContent } from "./layout.js";
import { renderWelcomeEmail, type WelcomeVariant } from "./welcome.js";

const log = logger.child({ module: "email" });

const RESEND_API_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

export interface SendEmailInput extends EmailContent {
    to: string;
    /** Resend tags — show up in the dashboard and on webhook events. */
    tags?: Record<string, string>;
    /** Idempotency key: Resend dedupes sends that reuse it within 24h. */
    idempotencyKey?: string;
    /**
     * Extra message headers — the `List-Unsubscribe` pair on the digest and
     * the alerts (`lib/unsubscribe-token.ts`). Resend sets them on the
     * message as given.
     */
    headers?: Record<string, string>;
    /**
     * Reply-To for this one message, overriding `EMAIL_REPLY_TO`. The
     * founder alert sets it to the sign-up's address so replying to the
     * alert is replying to the person.
     */
    replyTo?: string;
}

export type SendEmailResult =
    | { status: "sent"; messageId: string }
    | { status: "not_configured" }
    | { status: "failed"; error: string };

/**
 * Transactional email over Resend's REST API. Uses `fetch` directly: the
 * endpoint is a single POST, which keeps the server free of an SDK and makes
 * the transport trivially mockable in tests.
 *
 * Never throws. Email is a side effect of the caller's primary action (an
 * invite row, a billing receipt) and must not turn that action into a 500 —
 * callers record the returned status and move on.
 */
export const emailService = {
    isConfigured(): boolean {
        return Boolean(config.email.resendApiKey);
    },

    /**
     * Welcome email, sent once per account from whichever path first creates
     * the users row (/users/setup or an invite acceptance). The idempotency
     * key makes a double send impossible even if both paths race.
     */
    async sendWelcome(
        user: { id: string; email: string; name: string | null },
        variant: WelcomeVariant,
    ): Promise<SendEmailResult> {
        const content = renderWelcomeEmail({
            name: user.name,
            variant,
            appUrl: config.appUrl,
            docsUrl: `${config.siteUrl}/docs`,
        });
        return this.send({
            ...content,
            to: user.email,
            tags: { type: "welcome", variant: variant.kind },
            idempotencyKey: `welcome/${user.id}`,
        });
    },

    async send(input: SendEmailInput): Promise<SendEmailResult> {
        if (!config.email.resendApiKey) {
            log.warn({ to: input.to, subject: input.subject }, "RESEND_API_KEY not set — email not sent");
            return { status: "not_configured" };
        }

        const headers: Record<string, string> = {
            Authorization: `Bearer ${config.email.resendApiKey}`,
            "Content-Type": "application/json",
        };
        if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;

        const body: Record<string, unknown> = {
            from: config.email.from,
            to: [input.to],
            subject: input.subject,
            html: input.html,
            text: input.text,
        };
        const replyTo = input.replyTo || config.email.replyTo;
        if (replyTo) body["reply_to"] = replyTo;
        if (input.tags) body["tags"] = Object.entries(input.tags).map(([name, value]) => ({ name, value }));
        if (input.headers && Object.keys(input.headers).length > 0) body["headers"] = input.headers;

        try {
            const res = await fetch(RESEND_API_URL, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => "");
                const error = `Resend responded ${res.status}: ${detail.slice(0, 500)}`;
                log.error({ to: input.to, subject: input.subject, status: res.status }, "Email send rejected");
                return { status: "failed", error };
            }

            const json = (await res.json()) as { id?: string };
            if (!json.id) {
                log.error({ to: input.to }, "Resend response missing message id");
                return { status: "failed", error: "Resend response missing message id" };
            }
            log.info({ to: input.to, messageId: json.id, subject: input.subject }, "Email sent");
            return { status: "sent", messageId: json.id };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            log.error({ err, to: input.to, subject: input.subject }, "Email send failed");
            return { status: "failed", error };
        }
    },
};

import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import {
    buildAlertBatch,
    eventQualifies,
    shouldSendNow,
    type AlertBatch,
    type AlertCriteria,
} from "../lib/alert-batch.js";
import {
    alertSettingsUrl,
    renderAlertSlack,
    renderTestAlertSlack,
    type AlertMessageInput,
} from "../lib/alert-message.js";
import { maskWebhookUrl, postSlackWebhook } from "../lib/slack-webhook.js";
import { cloudHooks, type ChannelOutcome } from "../lib/cloud-hooks.js";
import { planHasAlerts } from "../config/plans.js";
import { alertRepository, type AlertOrg } from "../repositories/alert.repository.js";
import type { AlertChannel } from "../db/schema/alert-sends.js";

const log = createLogger("alert.service");

/** Defaults for the debounce (`lib/alert-batch.ts` `shouldSendNow`); the worker overrides from env. */
export const DEFAULT_ALERT_QUIET_MS = 10 * 60 * 1000;
export const DEFAULT_ALERT_MAX_DELAY_MS = 60 * 60 * 1000;

export interface AlertPassOptions {
    quietMs: number;
    maxDelayMs: number;
}

export interface AlertOrgResult {
    /** `started`: first pass, cursor seeded, nothing sent. `waiting`: burst still going. */
    outcome: "started" | "nothing" | "waiting" | "sent";
    advisories: number;
    events: number;
    sent: number;
    failed: number;
}

export interface AlertRunStats {
    orgs: number;
    started: number;
    waiting: number;
    messages: number;
    failed: number;
    advisories: number;
}

export type { ChannelOutcome };

/** The org row's two criteria columns as the batcher reads them. */
export function criteriaOf(org: Pick<AlertOrg, "alertMinSeverity" | "alertKev">): AlertCriteria {
    return { minSeverity: org.alertMinSeverity, kev: org.alertKev };
}

/**
 * The critical & KEV alerts — the first thing the product does that is felt
 * without opening it.
 *
 * Every few minutes the worker walks the eligible orgs and, for each, reads
 * the alert-relevant `activity_events` past its cursor (`alertRepository`),
 * keeps the ones that qualify (`lib/alert-batch.ts`), waits out a burst
 * (the debounce), then sends **one** message per channel grouped by
 * advisory and moves the cursor.
 *
 * Two channels. The **webhook** — the org's incoming webhook URL, through
 * the SSRF guard because the URL is the tenant's — is every edition's; it
 * is what the community edition has. **Email** to the org's owners and
 * admins is the cloud's, reached through `cloudHooks.alertEmail` and
 * absent otherwise (`src/edition.ts` `alerting`).
 *
 * The cursor moves *after* delivery. A send never throws — it records a
 * failed row and moves on — so the only way to re-offer a batch is a
 * process death mid-pass, and the email channel's idempotency key makes
 * that half harmless.
 *
 * Nothing here decides who is on which plan: `findAlertOrgs` filters on
 * `PLAN_LIMITS[plan].alerts` on the cloud, so a downgrade is silent by the
 * next pass; in the community edition every org with a webhook is visited.
 */
export const alertService = {
    /** What the settings page shows. `available` is the plan gate; `emailChannel` the edition's. */
    settingsView(org: AlertOrg) {
        return {
            available: planHasAlerts(org.plan),
            emailChannel: cloudHooks.alertEmail != null,
            plan: org.plan,
            emailEnabled: org.alertEmailEnabled,
            minSeverity: org.alertMinSeverity,
            kev: org.alertKev,
            slack: {
                configured: org.alertSlackWebhookUrl != null,
                masked: org.alertSlackWebhookUrl ? maskWebhookUrl(org.alertSlackWebhookUrl) : null,
            },
            quietMinutes: Math.round(DEFAULT_ALERT_QUIET_MS / 60_000),
        };
    },

    async processOrg(org: AlertOrg, now: Date, opts: AlertPassOptions): Promise<AlertOrgResult> {
        const none: AlertOrgResult = { outcome: "nothing", advisories: 0, events: 0, sent: 0, failed: 0 };

        // First time this org is eligible: start the clock now. The month of
        // events before it upgraded is history, not news.
        if (!org.alertsCursorAt) {
            await alertRepository.setCursor(org.id, now);
            return { ...none, outcome: "started" };
        }

        const settle = new Date(now.getTime() - opts.quietMs);
        if (settle <= org.alertsCursorAt) return none;

        const criteria = criteriaOf(org);
        const pending = (await alertRepository.findEvents(org.id, org.alertsCursorAt, settle)).filter((e) =>
            eventQualifies(e, criteria),
        );
        if (pending.length === 0) {
            await alertRepository.setCursor(org.id, settle);
            return none;
        }

        const recent = (await alertRepository.findEventsAfter(org.id, settle)).filter((e) =>
            eventQualifies(e, criteria),
        );
        const newestAt = [...pending, ...recent].reduce<Date | null>(
            (max, e) => (max == null || e.createdAt > max ? e.createdAt : max),
            null,
        );
        const oldestPendingAt = pending[0]!.createdAt;
        if (!shouldSendNow({ now, newestAt, oldestPendingAt, quietMs: opts.quietMs, maxDelayMs: opts.maxDelayMs })) {
            return { ...none, outcome: "waiting", events: pending.length };
        }

        const batch = buildAlertBatch(pending, criteria);
        if (batch.items.length === 0) {
            await alertRepository.setCursor(org.id, settle);
            return none;
        }
        const delivered = await this.deliver(org, batch, now);
        await alertRepository.setCursor(org.id, settle);
        return { outcome: "sent", advisories: batch.items.length, events: batch.eventCount, ...delivered };
    },

    /** Send one batch on every channel the org has on. Records a row per message. */
    async deliver(org: AlertOrg, batch: AlertBatch, now: Date): Promise<{ sent: number; failed: number }> {
        const stats = { sent: 0, failed: 0 };

        const email = cloudHooks.alertEmail;
        if (org.alertEmailEnabled && email) {
            const result = await email.deliver(org, batch, now);
            stats.sent += result.sent;
            stats.failed += result.failed;
        }

        if (org.alertSlackWebhookUrl) {
            const clusterIds = [...new Set(batch.items.flatMap((i) => i.clusterIds))];
            const clusterNames = await alertRepository.findClusterNames(clusterIds);
            const input: AlertMessageInput = {
                orgName: org.name,
                items: batch.items,
                clusterNames,
                appUrl: config.appUrl,
                settingsUrl: alertSettingsUrl(),
            };
            const text = renderAlertSlack(input);
            const result = await postSlackWebhook(org.alertSlackWebhookUrl, text, { untrusted: true });
            await alertRepository.recordSend({
                orgId: org.id,
                channel: "slack",
                userId: null,
                recipient: maskWebhookUrl(org.alertSlackWebhookUrl),
                subject:
                    input.items.length === 1
                        ? `${input.items[0]!.vulnId} on running images`
                        : `${input.items.length} advisories on running images`,
                eventIds: batch.eventIds,
                advisoryCount: batch.items.length,
                kind: "alert",
                resendMessageId: null,
                status: result.status,
                error: result.status === "failed" ? result.error.slice(0, 500) : null,
                sentAt: now,
                updatedAt: now,
            });
            if (result.status === "sent") stats.sent++;
            else {
                stats.failed++;
                log.warn({ orgId: org.id, error: result.error }, "Alert webhook refused the message");
            }
        }

        log.info(
            { orgId: org.id, advisories: batch.items.length, events: batch.eventCount, ...stats },
            "Alert batch delivered",
        );
        return stats;
    },

    /** The cron's body: every eligible org, one after another. */
    async runPass(
        now: Date = new Date(),
        opts: AlertPassOptions = { quietMs: DEFAULT_ALERT_QUIET_MS, maxDelayMs: DEFAULT_ALERT_MAX_DELAY_MS },
    ): Promise<AlertRunStats> {
        const orgs = await alertRepository.findAlertOrgs();
        const stats: AlertRunStats = {
            orgs: orgs.length,
            started: 0,
            waiting: 0,
            messages: 0,
            failed: 0,
            advisories: 0,
        };
        for (const org of orgs) {
            try {
                const r = await this.processOrg(org, now, opts);
                if (r.outcome === "started") stats.started++;
                if (r.outcome === "waiting") stats.waiting++;
                stats.messages += r.sent;
                stats.failed += r.failed;
                stats.advisories += r.advisories;
            } catch (error) {
                log.error({ error, orgId: org.id }, "Alert pass failed for org");
                stats.failed++;
            }
        }
        if (stats.messages > 0 || stats.failed > 0 || stats.waiting > 0) log.info(stats, "Alert pass complete");
        return stats;
    },

    /**
     * The settings page's "send a test": the email to the person who clicked
     * (cloud), the webhook test to the org's URL. Both recorded as
     * `kind: test` so the delivery log says what they were.
     */
    async sendTest(
        org: AlertOrg,
        requester: { id: string; email: string },
        now: Date = new Date(),
    ): Promise<Record<AlertChannel, ChannelOutcome>> {
        const out: Record<AlertChannel, ChannelOutcome> = {
            email: { status: "not_configured" },
            slack: { status: "not_configured" },
        };

        const email = cloudHooks.alertEmail;
        if (org.alertEmailEnabled && email) {
            out.email = await email.sendTest(org, requester, now);
        }

        if (org.alertSlackWebhookUrl) {
            const result = await postSlackWebhook(
                org.alertSlackWebhookUrl,
                renderTestAlertSlack({ orgName: org.name, settingsUrl: alertSettingsUrl() }),
                { untrusted: true },
            );
            out.slack = result;
            await alertRepository.recordSend({
                orgId: org.id,
                channel: "slack",
                userId: null,
                recipient: maskWebhookUrl(org.alertSlackWebhookUrl),
                subject: `Test alert for ${org.name}`,
                eventIds: [],
                advisoryCount: 0,
                kind: "test",
                resendMessageId: null,
                status: result.status,
                error: result.status === "failed" ? result.error.slice(0, 500) : null,
                sentAt: now,
                updatedAt: now,
            });
        }

        return out;
    },
};

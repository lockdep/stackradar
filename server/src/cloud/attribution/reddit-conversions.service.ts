// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";

const log = logger.child({ module: "reddit-conversions" });

const SEND_TIMEOUT_MS = 10_000;

/**
 * Reddit's standard conversion event names (Conversions API v3 spelling).
 * `SIGN_UP` and `LEAD` are the two this product reports; the rest are listed
 * so a future call site picks a name Reddit's optimiser already understands
 * rather than a custom one.
 */
export type RedditTrackingType =
    | "PAGE_VISIT"
    | "VIEW_CONTENT"
    | "SEARCH"
    | "ADD_TO_CART"
    | "ADD_TO_WISHLIST"
    | "PURCHASE"
    | "LEAD"
    | "SIGN_UP";

export interface RedditConversionInput {
    trackingType: RedditTrackingType;
    /** Reddit's click identifier (`rdt_cid`), the only user-matching signal sent. */
    clickId: string;
    /**
     * Stable per-conversion key. Reddit dedupes on it, so a retried send of
     * the same conversion is counted once.
     */
    conversionId: string;
    /** When the conversion happened; defaults to now. Reddit rejects anything older than seven days. */
    eventAt?: Date;
}

export type RedditConversionResult =
    | { status: "sent" }
    | { status: "not_configured" }
    | { status: "failed"; error: string };

/**
 * Reddit Ads Conversions API v3 — the server-to-server way to tell Reddit an
 * ad click converted, used instead of the Reddit Pixel so the marketing site
 * stays cookieless (the marketing site's PostHog provider explains
 * the stance).
 *
 * Wire format, from Reddit's v3 guide (`POST /api/v3/pixels/{pixel}/conversion_events`):
 * a `data` wrapper holding the events, `event_at` as Unix milliseconds,
 * `action_source` mandatory, tracking types in UPPER_SNAKE_CASE, and an
 * optional `data.test_id` that routes the batch to Events Manager's test
 * view instead of the live count. The v2.0 endpoint still answers but is
 * deprecated; do not go back to it.
 *
 * Every event carries exactly one matching signal, the click id. Reddit
 * accepts that alone; email, IP and user agent are deliberately never sent.
 * Without a click id there is nothing to attribute, and the caller must not
 * call this at all.
 *
 * Like `emailService`, this never throws: reporting a conversion is a side
 * effect of sign-up and inventory ingest, and neither may fail because an ad
 * network was down. Unconfigured (no pixel id or token, the local and dev
 * default) means "skipped and logged", not an error.
 */
export const redditConversionsService = {
    isConfigured(): boolean {
        return Boolean(config.reddit.pixelId && config.reddit.conversionsToken);
    },

    async send(input: RedditConversionInput): Promise<RedditConversionResult> {
        if (!this.isConfigured()) {
            log.info(
                { trackingType: input.trackingType, conversionId: input.conversionId },
                "Reddit conversions not configured — event not sent",
            );
            return { status: "not_configured" };
        }

        const url = `${config.reddit.conversionsApiUrl}/${encodeURIComponent(config.reddit.pixelId)}/conversion_events`;
        const body = {
            data: {
                ...(config.reddit.testId ? { test_id: config.reddit.testId } : {}),
                events: [
                    {
                        event_at: (input.eventAt ?? new Date()).getTime(),
                        action_source: "WEBSITE",
                        // Recommended on website events so Events Manager can
                        // attribute the domain; without it the source shows
                        // as "Undetectable". Both conversions start at the
                        // login page, which is also the URL the click id
                        // arrived on.
                        event_source_url: `${config.appUrl}/login`,
                        type: { tracking_type: input.trackingType },
                        click_id: input.clickId,
                        metadata: { conversion_id: input.conversionId },
                    },
                ],
            },
        };

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.reddit.conversionsToken}`,
                    "Content-Type": "application/json",
                    // Reddit's API rejects requests without a user agent.
                    "User-Agent": "stackradar-server",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => "");
                const error = `Reddit responded ${res.status}: ${detail.slice(0, 500)}`;
                log.error(
                    {
                        trackingType: input.trackingType,
                        conversionId: input.conversionId,
                        status: res.status,
                        detail: detail.slice(0, 500),
                    },
                    "Reddit conversion rejected",
                );
                return { status: "failed", error };
            }

            log.info(
                {
                    trackingType: input.trackingType,
                    conversionId: input.conversionId,
                    test: Boolean(config.reddit.testId),
                },
                "Reddit conversion sent",
            );
            return { status: "sent" };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            log.error(
                { err, trackingType: input.trackingType, conversionId: input.conversionId },
                "Reddit conversion send failed",
            );
            return { status: "failed", error };
        }
    },
};

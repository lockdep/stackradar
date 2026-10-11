import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "posthog" });

const SEND_TIMEOUT_MS = 10_000;

/**
 * The server-side funnel events. Names are the funnel's steps so the
 * PostHog funnel reads the way the plan was written: a drop at
 * `signup_completed` means the landing page is not landing, a drop at
 * `first_sbom_received` means the install is too hard. Add to this union
 * rather than passing free strings so the event vocabulary stays in one
 * place.
 */
export type ServerEventName = "signup_completed" | "first_sbom_received";

export interface ServerEventInput {
    event: ServerEventName;
    /**
     * The organization id. Every server-side event is about an org, not a
     * browser: the founder signs up once, the org's clusters report in.
     * Using the org id makes the two events land on one PostHog person, so a
     * funnel between them just works, and the dashboard's browser-side
     * events (identified by user id) stay separate — joining the two
     * would need the browser to alias to the org, which is deliberately
     * not done so no email or user id ever leaves this process.
     */
    distinctId: string;
    properties?: Record<string, unknown>;
    /**
     * Person properties written only if unset (`$set_once`): the sign-up's
     * campaign tags, so a breakdown of `first_sbom_received` by
     * `utm_source` works without copying the tags onto every event.
     */
    setOnce?: Record<string, unknown>;
    /** When the event happened; defaults to now. */
    timestamp?: Date;
}

export type ServerEventResult = { status: "sent" } | { status: "not_configured" } | { status: "failed"; error: string };

/**
 * PostHog capture over the public single-event endpoint (`POST /i/v0/e`),
 * with `fetch` rather than `posthog-node`: two events per organization
 * lifetime do not need a batching queue, and a queue would need a flush on
 * shutdown that the job worker and API server would each have to wire.
 *
 * The browser SDKs on the marketing site and dashboard cannot see these
 * moments: the landing page is cookieless by design, so a visitor and the
 * account they create are never the same PostHog person, and a cluster
 * reporting in has no browser at all. This sender is how the funnel gets
 * its middle.
 *
 * Every event is geo-disabled (the IP PostHog would see is this pod's) and
 * carries no email, user id, IP or user agent. Like `emailService` and
 * `redditConversionsService`, it never throws: an analytics outage must
 * not fail setup or inventory ingest. Unconfigured (no project token, the
 * local default) means "skipped and logged", not an error.
 */
export const posthogService = {
    isConfigured(): boolean {
        return Boolean(config.posthog.apiKey);
    },

    async capture(input: ServerEventInput): Promise<ServerEventResult> {
        if (!this.isConfigured()) {
            log.info({ event: input.event, distinctId: input.distinctId }, "PostHog not configured — event not sent");
            return { status: "not_configured" };
        }

        const url = `${config.posthog.host.replace(/\/+$/, "")}/i/v0/e`;
        const body = {
            api_key: config.posthog.apiKey,
            event: input.event,
            distinct_id: input.distinctId,
            timestamp: (input.timestamp ?? new Date()).toISOString(),
            properties: {
                ...input.properties,
                ...(input.setOnce ? { $set_once: input.setOnce } : {}),
                $lib: "stackradar-server",
                // The request comes from the pod, not the person. Without
                // this every server event would be located at the cluster's
                // datacentre and pollute the country breakdowns.
                $geoip_disable: true,
            },
        };

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "User-Agent": "stackradar-server" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => "");
                const error = `PostHog responded ${res.status}: ${detail.slice(0, 500)}`;
                log.error(
                    {
                        event: input.event,
                        distinctId: input.distinctId,
                        status: res.status,
                        detail: detail.slice(0, 500),
                    },
                    "PostHog event rejected",
                );
                return { status: "failed", error };
            }

            log.info({ event: input.event, distinctId: input.distinctId }, "PostHog event sent");
            return { status: "sent" };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            log.error({ err, event: input.event, distinctId: input.distinctId }, "PostHog event send failed");
            return { status: "failed", error };
        }
    },
};

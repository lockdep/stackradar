// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { attributionRepository, type SignupAttributionInput } from "./attribution.repository.js";
import { clusterRepository } from "../../repositories/cluster.repository.js";
import { organizationRepository } from "../../repositories/organization.repository.js";
import { userRepository } from "../../repositories/user.repository.js";
import type { SignupAttribution } from "../../db/schema/index.js";
import { redditConversionsService } from "./reddit-conversions.service.js";
import { posthogService } from "../../services/posthog.service.js";
import { founderAlertService } from "./founder-alert.service.js";
import type { FounderAlertOrigin } from "./founder-alert-email.js";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";

const log = logger.child({ module: "attribution" });

/** The account and org a sign-up created, as setup already holds them. */
export interface SignupIdentity {
    user: { id: string; email: string; name: string | null };
    org: { id: string; name: string };
}

/** What an inventory report says about itself, for the first-cluster alert. */
export interface ClusterReport {
    clusterId: string;
    accepted: { namespaces: number; workloads: number; containers: number };
    scannerVersion: string | null;
}

/**
 * Sign-up attribution and the funnel events built on it.
 *
 * Two moments matter for a self-signed-up organization: the sign-up itself
 * and the first cluster that actually reports in. Each moment is reported
 * to three receivers:
 *
 * - PostHog, for every org, as `signup_completed` / `first_sbom_received`
 *   keyed on the org id, with the campaign tags the sign-up carried. This
 *   is the funnel's middle — the cookieless marketing site cannot connect
 *   a visitor to the account they create, and a reporting cluster has no
 *   browser — and it counts organic sign-ups, so channels can be compared.
 * - The founder, for every org, by email and/or Slack
 *   (`founder-alert.service.ts`): who signed up, from where, and when their
 *   first cluster landed, so a real sign-up gets a personal reply within a
 *   day rather than being found in a dashboard weeks later.
 * - The ad network the click came from (Reddit today), only when the row
 *   carries a click id, so the network can optimise delivery on real
 *   conversions.
 *
 * Both entry points are side effects of a request that must succeed
 * regardless (setup, inventory ingest), so neither throws and both are safe
 * to call unawaited. The `*_sent_at` stamps on the row make every send
 * at-most-once across retries and replicas: a stamp is written only after
 * the receiver accepted the event, and a stamped row is skipped.
 *
 * A second ad network would add its own click-id column and a second sender
 * behind the same two calls.
 */
export const attributionService = {
    /**
     * Called once from `POST /users/setup` when the account's first org is
     * created, with whatever attribution the login link carried (possibly
     * nothing). Inserting the row is awaited so a crash after the response
     * cannot lose it; the network calls are not, so an analytics or ad API
     * outage adds no latency to the first dashboard load.
     */
    async recordSignup(identity: SignupIdentity, input: SignupAttributionInput): Promise<void> {
        const { user, org } = identity;
        const userId = user.id;
        const orgId = org.id;
        try {
            const row = await attributionRepository.create(userId, orgId, input);
            if (!row) return; // already recorded (setup re-posted)
            log.info(
                { userId, orgId, hasClickId: Boolean(row.clickId), utmSource: row.utmSource, utmCampaign: row.utmCampaign, timezone: row.timezone },
                "Recorded sign-up attribution"
            );

            void (async () => {
                const result = await posthogService.capture({
                    event: "signup_completed",
                    distinctId: orgId,
                    timestamp: row.createdAt,
                    properties: eventProperties(row),
                    setOnce: { ...eventProperties(row), signup_at: row.createdAt.toISOString() },
                });
                if (result.status === "sent") {
                    await attributionRepository.markAnalyticsSignupSent(userId);
                }
            })().catch((err) => log.error({ err, userId }, "Sign-up analytics event failed"));

            void (async () => {
                const result = await founderAlertService.notifySignup({
                    person: { email: user.email, name: user.name },
                    org,
                    origin: origin(row),
                    signedUpAt: row.createdAt,
                    adminUrl: adminUrl(),
                });
                if (result.status === "sent") {
                    await attributionRepository.markFounderSignupAlertSent(userId);
                }
            })().catch((err) => log.error({ err, userId }, "Sign-up founder alert failed"));

            if (!row.clickId) return;
            const clickId = row.clickId;
            void (async () => {
                const result = await redditConversionsService.send({
                    trackingType: "SIGN_UP",
                    clickId,
                    conversionId: `signup:${userId}`,
                    eventAt: row.createdAt,
                });
                if (result.status === "sent") {
                    await attributionRepository.markSignupEventSent(userId);
                }
            })().catch((err) => log.error({ err, userId }, "Sign-up conversion report failed"));
        } catch (err) {
            log.error({ err, userId, orgId }, "Failed to record sign-up attribution");
        }
    },

    /**
     * Called from every inventory report. One indexed read per report; a
     * network call only for the org whose founder still owes an event,
     * which is the org's first report and then never again.
     */
    async onClusterReported(orgId: string, report: ClusterReport): Promise<void> {
        try {
            const pending = await attributionRepository.findPendingClusterEvents(orgId);
            for (const row of pending) {
                const now = new Date();
                // Time-to-first-cluster is the install-friction number
                // FIRST-CUSTOMERS.md wants; a lower bound if the report
                // arrived while the server was down.
                const hoursSinceSignup = Math.round(((now.getTime() - row.createdAt.getTime()) / 3_600_000) * 10) / 10;

                if (!row.analyticsClusterSentAt) {
                    const result = await posthogService.capture({
                        event: "first_sbom_received",
                        distinctId: orgId,
                        timestamp: now,
                        properties: { ...eventProperties(row), hours_since_signup: hoursSinceSignup },
                    });
                    if (result.status === "sent") {
                        await attributionRepository.markAnalyticsClusterSent(row.userId);
                        log.info({ orgId, userId: row.userId }, "Sent first-inventory analytics event");
                    }
                }

                if (!row.founderClusterAlertSentAt && founderAlertService.isConfigured()) {
                    // Three point reads, once per org lifetime: the alert
                    // names the org, the cluster and the person to reply to.
                    const [org, user, cluster] = await Promise.all([
                        organizationRepository.getOrganizationById(orgId),
                        userRepository.getUserById(row.userId),
                        clusterRepository.findById(report.clusterId, orgId),
                    ]);
                    if (org && user) {
                        const result = await founderAlertService.notifyFirstCluster({
                            person: { email: user.email, name: user.name },
                            org: { id: org.id, name: org.name },
                            origin: origin(row),
                            cluster: { id: report.clusterId, name: cluster?.name ?? report.clusterId },
                            accepted: report.accepted,
                            scannerVersion: report.scannerVersion,
                            hoursSinceSignup,
                            adminUrl: adminUrl(),
                        });
                        if (result.status === "sent") {
                            await attributionRepository.markFounderClusterAlertSent(row.userId);
                            log.info({ orgId, userId: row.userId }, "Sent first-inventory founder alert");
                        }
                    } else {
                        log.warn({ orgId, userId: row.userId }, "First-inventory founder alert skipped: org or user missing");
                    }
                }

                if (row.clickId && !row.clusterEventSentAt) {
                    const result = await redditConversionsService.send({
                        trackingType: "LEAD",
                        clickId: row.clickId,
                        conversionId: `cluster:${row.userId}`,
                    });
                    if (result.status === "sent") {
                        await attributionRepository.markClusterEventSent(row.userId);
                        log.info({ orgId, userId: row.userId }, "Reported cluster-connected conversion");
                    }
                }
            }
        } catch (err) {
            log.error({ err, orgId }, "Cluster-connected event report failed");
        }
    },
};

/**
 * What an event says about where the org came from. The campaign tags,
 * which ad network the click id belongs to, and the browser's time zone and
 * language; never the click id itself (it is the network's key, not ours),
 * and never the user id or email.
 */
function eventProperties(row: SignupAttribution): Record<string, string | null> {
    return {
        org_id: row.orgId,
        utm_source: row.utmSource,
        utm_medium: row.utmMedium,
        utm_campaign: row.utmCampaign,
        utm_content: row.utmContent,
        utm_term: row.utmTerm,
        timezone: row.timezone,
        locale: row.locale,
        ad_network: adNetwork(row),
    };
}

/**
 * Which network's click id the row carries. Reddit is the only network
 * wired, so a click id means Reddit; a second network gets its own column
 * and its own value here.
 */
function adNetwork(row: SignupAttribution): string | null {
    return row.clickId ? "reddit" : null;
}

function origin(row: SignupAttribution): FounderAlertOrigin {
    return {
        timezone: row.timezone,
        locale: row.locale,
        utmSource: row.utmSource,
        utmMedium: row.utmMedium,
        utmCampaign: row.utmCampaign,
        utmContent: row.utmContent,
        adNetwork: adNetwork(row),
    };
}

/** The dashboard's admin page, where the operator can look the org up. */
function adminUrl(): string {
    return `${config.appUrl}/admin`;
}

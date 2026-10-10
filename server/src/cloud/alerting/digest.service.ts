// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { orgRiskRollup } from "../../db/risk.js";
import { baseImageArrivals, summariseSince } from "../../lib/since-summary.js";
import { parseTierParam } from "../../db/finding-tier.js";
import { listUnsubscribeHeaders, unsubscribeUrl } from "./unsubscribe-token.js";
import { renderDigestEmail, type DigestFinding, type DigestUpstream } from "./digest-email.js";
import { fixesForOrg, type FixesPage } from "../../services/remediation.service.js";
import { emailService } from "../email/email.service.js";
import { digestRepository } from "./digest.repository.js";
import { radarScoreRepository, type TopFinding } from "../../repositories/radar-score.repository.js";
import { metricsRepository } from "../../repositories/metrics.repository.js";
import { workloadRepository } from "../../repositories/workload.repository.js";
import { activityFeedRepository } from "../../repositories/activity-feed.repository.js";

const log = createLogger("digest.service");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** How many "Start here" rows the mail carries — the Dashboard block's top half. */
const TOP_FINDINGS = 5;
const APPLICATION_LENS = parseTierParam("application,main");

/** `YYYY-Www` — the ISO 8601 week, for the idempotency key and the subject. */
export function isoWeek(date: Date): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function imageLabel(f: TopFinding): string {
    const path = [f.registry, f.repository].filter(Boolean).join("/");
    if (!path) return f.digest.slice(0, 19);
    return f.tags.length > 0 ? `${path}:${f.tags.join(", ")}` : path;
}

/** What is waiting on someone else: measured upstream upgrades, and third-party images with no move at all. */
export function summariseUpstream(fixes: Pick<FixesPage, "fixes" | "waitingOnUpstream">): DigestUpstream {
    const upgrades = fixes.fixes.filter((f) => f.control === "third-party");
    const chartUpgrades = upgrades.filter((f) => f.kind === "chart");
    return {
        chartUpgrades: chartUpgrades.length,
        imageUpgrades: upgrades.length - chartUpgrades.length,
        findingsRemoved: upgrades.reduce((n, f) => n + (f.cleared?.findings ?? 0), 0),
        waitingImages: fixes.waitingOnUpstream.images,
    };
}

/** Base-image rebuilds on images the org builds, and what they remove. */
export function summariseBaseRebuilds(fixes: Pick<FixesPage, "fixes">): { count: number; findingsRemoved: number } {
    const rebuilds = fixes.fixes.filter((f) => f.kind === "base");
    return { count: rebuilds.length, findingsRemoved: rebuilds.reduce((n, f) => n + (f.cleared?.findings ?? 0), 0) };
}

export interface DigestRunStats {
    orgs: number;
    sent: number;
    skipped: number;
    failed: number;
}

/**
 * The weekly digest — plan item 5b, the product's first push channel.
 *
 * One mail per owner or admin per org per ISO week, Monday 07:00 UTC from
 * the worker. Orgs with nothing scanned, the demo org and the platform org
 * are never mailed; an org switches itself off with the settings toggle or
 * the unsubscribe link. The Resend idempotency key
 * (`digest/<org>/<user>/<week>`) makes a re-run of a crashed pass safe.
 *
 * `emailService.send` never throws, so a rejected send costs one row in
 * `digest_sends` with `status: failed` and the pass carries on.
 */
export const digestService = {
    /** Everything one org's mail says — separated so tests can assert the content without Resend. */
    async assemble(orgId: string, now: Date = new Date()) {
        const weekAgo = new Date(now.getTime() - WEEK_MS);
        // The org's default findings view decides what "Start here" is drawn from.
        const [org] = await db
            .select({ defaultFindingTier: schema.organizations.defaultFindingTier })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, orgId));
        const lens = org?.defaultFindingTier === "all" ? undefined : APPLICATION_LENS;
        const [risk, snapshot, top, events, coverage, clusters, fixes] = await Promise.all([
            orgRiskRollup(orgId),
            metricsRepository.findOrgSnapshotBefore(orgId, weekAgo),
            // What the reader can act on: findings in packages their build
            // added, plus anything exploited wherever it lives (the lens's
            // own rule). Base-image findings get one line below, not rows —
            // until item 7 can say what removes them, a row would be a
            // problem with no move attached.
            radarScoreRepository.findTopFindings({ orgId }, TOP_FINDINGS, lens, "yours"),
            activityFeedRepository.listSince(orgId, weekAgo),
            workloadRepository.coverageByOrg(orgId),
            db.select({ id: schema.clusters.id, name: schema.clusters.name }).from(schema.clusters).where(eq(schema.clusters.orgId, orgId)),
            // The upstream line. A failure here must not cost the org its mail.
            fixesForOrg(orgId).catch((error: unknown) => {
                log.warn({ error, orgId }, "Could not assemble the upstream line for the digest");
                return null;
            }),
        ]);
        const since = summariseSince(events, weekAgo, now);
        const clusterName = new Map(clusters.map((c) => [c.id, c.name]));

        const topFindings: DigestFinding[] = top.findings.map((f) => ({
            vulnId: f.vulnId,
            packageName: f.packageName,
            packageVersion: f.packageVersion,
            fixedVersion: f.fixedVersion,
            risk: f.riskScore ?? 0,
            kev: f.kevListedAt != null,
            epssScore: f.epssScore,
            imageLabel: imageLabel(f),
            imageId: f.imageId,
            clusterName: f.clusterName,
            workloadCount: f.workloadCount,
            containerCount: f.containerCount,
        }));

        return {
            week: isoWeek(now),
            radarScore: risk.score,
            radarScoreWeekAgo: snapshot?.riskScore ?? null,
            findingCount: risk.findingCount,
            topFindings,
            newKevVulnIds: since.newKev.vulnIds,
            startHereScope: lens ? ("application" as const) : ("all" as const),
            upstream: fixes ? summariseUpstream(fixes) : null,
            baseRebuilds: fixes ? summariseBaseRebuilds(fixes) : null,
            baseImageArrivals: baseImageArrivals(events),
            baseImageFindings: top.tierCounts.base,
            newFindings: since.newFindings.count,
            resolvedFindings: since.resolvedFindings.count,
            coverageProblems: coverage
                .filter((c) => c.registryAuthFailedWorkloads > 0)
                .map((c) => ({
                    clusterName: clusterName.get(c.clusterId) ?? c.clusterId,
                    hosts: c.registryAuthFailedHosts,
                    workloads: c.registryAuthFailedWorkloads,
                })),
        };
    },

    async sendForOrg(org: { id: string; name: string }, now: Date = new Date()): Promise<Omit<DigestRunStats, "orgs">> {
        const stats = { sent: 0, skipped: 0, failed: 0 };
        const recipients = await digestRepository.findRecipients(org.id);
        if (recipients.length === 0) {
            stats.skipped++;
            return stats;
        }
        const content = await this.assemble(org.id, now);
        const unsubscribe = unsubscribeUrl("digest", org.id);

        for (const user of recipients) {
            const mail = renderDigestEmail({
                ...content,
                orgName: org.name,
                name: user.name,
                appUrl: config.appUrl,
                unsubscribeUrl: unsubscribe,
            });
            const result = await emailService.send({
                ...mail,
                to: user.email,
                tags: { type: "weekly_digest", org_id: org.id, week: content.week },
                idempotencyKey: `digest/${org.id}/${user.id}/${content.week}`,
                headers: listUnsubscribeHeaders(unsubscribe),
            });
            if (result.status === "not_configured") {
                stats.skipped++;
                continue;
            }
            await digestRepository.recordSend({
                orgId: org.id,
                userId: user.id,
                email: user.email,
                week: content.week,
                resendMessageId: result.status === "sent" ? result.messageId : null,
                status: result.status === "sent" ? "sent" : "failed",
                sentAt: now,
                updatedAt: now,
            });
            if (result.status === "sent") stats.sent++;
            else stats.failed++;
        }
        return stats;
    },

    /** The Monday pass: every org due a digest, one after another. */
    async sendWeeklyDigests(now: Date = new Date()): Promise<DigestRunStats> {
        const orgs = await digestRepository.findDigestOrgs();
        const stats: DigestRunStats = { orgs: orgs.length, sent: 0, skipped: 0, failed: 0 };
        for (const org of orgs) {
            try {
                const s = await this.sendForOrg(org, now);
                stats.sent += s.sent;
                stats.skipped += s.skipped;
                stats.failed += s.failed;
            } catch (error) {
                log.error({ error, orgId: org.id }, "Weekly digest failed for org");
                stats.failed++;
            }
        }
        log.info(stats, "Weekly digest pass complete");
        return stats;
    },

    /** The unsubscribe link's action. False when the token names no live org. */
    async unsubscribe(orgId: string): Promise<boolean> {
        const ok = await digestRepository.setEnabled(orgId, false);
        if (ok) log.info({ orgId }, "Weekly digest switched off via unsubscribe link");
        return ok;
    },
};

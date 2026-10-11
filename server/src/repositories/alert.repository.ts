import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isTenantOrg } from "../db/tenant-orgs.js";
import { ALERT_PLANS } from "../config/plans.js";
import { edition } from "../edition.js";
import type { ActivityEvent, ActivityEventType } from "../db/schema/remediation.js";
import type { AlertSend, AlertSendStatus, NewAlertSend } from "../db/schema/alert-sends.js";
import type { InviteEmailStatus } from "../db/schema/org-invites.js";

/** The event types the alert worker reads. Everything else is not its business. */
export const ALERT_EVENT_TYPES: readonly ActivityEventType[] = ["scan.findings-changed", "finding.kev-listed"];

/**
 * One pass reads at most this many events per org. A fleet-wide mirror
 * rescan is hundreds of events, not thousands; the cap keeps a pathological
 * window bounded and a truncated batch under-names rather than blocks.
 */
const EVENTS_PER_PASS = 2_000;

export interface AlertOrg {
    id: string;
    name: string;
    plan: string;
    alertEmailEnabled: boolean;
    alertSlackWebhookUrl: string | null;
    alertMinSeverity: "critical" | "high" | "none";
    alertKev: boolean;
    alertsCursorAt: Date | null;
}

/** The columns that make an {@link AlertOrg}, for the two selects that return one. */
function alertOrgColumns() {
    const o = schema.organizations;
    return {
        id: o.id,
        name: o.name,
        plan: o.plan,
        alertEmailEnabled: o.alertEmailEnabled,
        alertSlackWebhookUrl: o.alertSlackWebhookUrl,
        alertMinSeverity: o.alertMinSeverity,
        alertKev: o.alertKev,
        alertsCursorAt: o.alertsCursorAt,
    };
}

/**
 * Who gets the critical & KEV alerts, the events they are built from, and
 * the log of what was sent (`services/alert.service.ts`).
 */
export const alertRepository = {
    /**
     * Orgs the pass visits: tenants not deleted, with at least one channel
     * on — and, on the cloud, on a plan with alerts. The plan check is here,
     * not in a settings write — a downgrade must silence alerts without
     * anyone touching the org's columns. In the community edition the plan
     * column is not consulted and the webhook is the only channel, so an
     * org is visited exactly when it has set one.
     */
    async findAlertOrgs(): Promise<AlertOrg[]> {
        const o = schema.organizations;
        const channelOn =
            edition.alerting === "full"
                ? or(eq(o.alertEmailEnabled, true), isNotNull(o.alertSlackWebhookUrl))
                : isNotNull(o.alertSlackWebhookUrl);
        return db
            .select(alertOrgColumns())
            .from(o)
            .where(
                and(
                    isTenantOrg(),
                    isNull(o.deletedAt),
                    edition.billing ? inArray(o.plan, [...ALERT_PLANS]) : undefined,
                    channelOn,
                ),
            )
            .orderBy(o.createdAt);
    },

    /**
     * The org's alert-relevant events in `(after, until]`, oldest first. `after`
     * null means "from the beginning" — only the first pass asks that, and it
     * asks with `until` = the cursor it is about to write, to seed it.
     */
    async findEvents(orgId: string, after: Date | null, until: Date): Promise<ActivityEvent[]> {
        const e = schema.activityEvents;
        return db
            .select()
            .from(e)
            .where(
                and(
                    eq(e.orgId, orgId),
                    inArray(e.type, ALERT_EVENT_TYPES),
                    after ? gt(e.createdAt, after) : undefined,
                    lte(e.createdAt, until),
                ),
            )
            .orderBy(asc(e.createdAt), asc(e.id))
            .limit(EVENTS_PER_PASS);
    },

    /** Events newer than `after` — the debounce's "is the burst still going" read. */
    async findEventsAfter(orgId: string, after: Date): Promise<ActivityEvent[]> {
        const e = schema.activityEvents;
        return db
            .select()
            .from(e)
            .where(and(eq(e.orgId, orgId), inArray(e.type, ALERT_EVENT_TYPES), gt(e.createdAt, after)))
            .orderBy(asc(e.createdAt), asc(e.id))
            .limit(EVENTS_PER_PASS);
    },

    async setCursor(orgId: string, at: Date): Promise<void> {
        await db
            .update(schema.organizations)
            .set({ alertsCursorAt: at, updatedAt: new Date() })
            .where(eq(schema.organizations.id, orgId));
    },

    async findClusterNames(clusterIds: string[]): Promise<Record<string, string>> {
        if (clusterIds.length === 0) return {};
        const rows = await db
            .select({ id: schema.clusters.id, name: schema.clusters.name })
            .from(schema.clusters)
            .where(inArray(schema.clusters.id, clusterIds));
        return Object.fromEntries(rows.map((r) => [r.id, r.name]));
    },

    async recordSend(data: NewAlertSend): Promise<AlertSend> {
        const [row] = await db.insert(schema.alertSends).values(data).returning();
        return row!;
    },

    /** The settings page's delivery log, newest first. */
    async listRecentSends(orgId: string, limit = 10): Promise<AlertSend[]> {
        return db
            .select()
            .from(schema.alertSends)
            .where(eq(schema.alertSends.orgId, orgId))
            .orderBy(desc(schema.alertSends.sentAt), desc(schema.alertSends.id))
            .limit(limit);
    },

    /**
     * Apply a delivery event from the provider's webhook, keyed by message
     * id. False when no alert send carries that id. Same vocabulary as the
     * digest's.
     */
    async applyEmailEvent(messageId: string, status: InviteEmailStatus, at: Date): Promise<boolean> {
        if (status === "not_configured") return false;
        const rows = await db
            .update(schema.alertSends)
            .set({ status: status as AlertSendStatus, updatedAt: at })
            .where(eq(schema.alertSends.resendMessageId, messageId))
            .returning({ id: schema.alertSends.id });
        return rows.length > 0;
    },

    /**
     * The settings write. `alertSlackWebhookUrl: null` removes the webhook.
     * The plan check is the controller's; this only writes.
     */
    async updateSettings(
        orgId: string,
        data: {
            alertEmailEnabled?: boolean | undefined;
            alertSlackWebhookUrl?: string | null | undefined;
            alertMinSeverity?: AlertOrg["alertMinSeverity"] | undefined;
            alertKev?: boolean | undefined;
        },
    ): Promise<AlertOrg | null> {
        const set: Partial<typeof schema.organizations.$inferInsert> = { updatedAt: new Date() };
        if (data.alertEmailEnabled !== undefined) set.alertEmailEnabled = data.alertEmailEnabled;
        if (data.alertSlackWebhookUrl !== undefined) set.alertSlackWebhookUrl = data.alertSlackWebhookUrl;
        if (data.alertMinSeverity !== undefined) set.alertMinSeverity = data.alertMinSeverity;
        if (data.alertKev !== undefined) set.alertKev = data.alertKev;
        const o = schema.organizations;
        const [row] = await db
            .update(o)
            .set(set)
            .where(and(eq(o.id, orgId), isNull(o.deletedAt)))
            .returning(alertOrgColumns());
        return row ?? null;
    },

    /** The unsubscribe link's action: the email channel off. False when the token names no live org. */
    async setEmailEnabled(orgId: string, enabled: boolean): Promise<boolean> {
        const o = schema.organizations;
        const rows = await db
            .update(o)
            .set({ alertEmailEnabled: enabled, updatedAt: new Date() })
            .where(and(eq(o.id, orgId), isNull(o.deletedAt)))
            .returning({ id: o.id });
        return rows.length > 0;
    },

    /** How many alert messages went out platform-wide since `since` — the admin's sanity number. */
    async countSendsSince(since: Date): Promise<number> {
        const [row] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.alertSends)
            .where(and(gt(schema.alertSends.sentAt, since), eq(schema.alertSends.kind, "alert")));
        return row?.n ?? 0;
    },
};

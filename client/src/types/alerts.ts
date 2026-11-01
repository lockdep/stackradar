/**
 * The alert channels as any org member may see them —
 * `GET /api/organizations/:id/notifications/summary`. Mirrors the server's
 * `AlertSummary` (`server/src/services/alert.service.ts`); the property names
 * are gated by `scripts/check-cross-app-constants.mjs`. Deliberately thin:
 * the webhook's host and a recipient count, never the URL or an address —
 * those stay on the owner/admin read (`…/alerts`).
 */
export interface AlertSummary {
    /** The plan gate — alerts are a Pro and Business feature on the cloud. */
    available: boolean;
    /** Whether the email channel exists at all (cloud edition). */
    emailChannel: boolean;
    emailEnabled: boolean;
    /** Owners and admins the email channel reaches; 0 where there is no email channel. */
    recipientCount: number;
    webhookConfigured: boolean;
    /** e.g. `hooks.slack.com`; null when no webhook is set. */
    webhookHost: string | null;
}

/** The path the summary is read from, for `useResource`. */
export function alertSummaryPath(orgId: string): string {
    return `/api/organizations/${orgId}/notifications/summary`;
}

/**
 * One line saying where alerts go: "Enabled · Slack: hooks.slack.com · email
 * to 3 owners and admins", or what stands in its way. A Slack host is named
 * Slack; any other incoming webhook (Teams, Mattermost, Discord) is a webhook.
 */
export function alertSummaryLine(s: AlertSummary): string {
    if (!s.available) return 'Not included in this plan';
    const parts: string[] = [];
    if (s.webhookConfigured && s.webhookHost) {
        const label = s.webhookHost.endsWith('hooks.slack.com') ? 'Slack' : 'Webhook';
        parts.push(`${label}: ${s.webhookHost}`);
    }
    if (s.emailChannel && s.emailEnabled) {
        parts.push(`email to ${s.recipientCount} ${s.recipientCount === 1 ? 'owner or admin' : 'owners and admins'}`);
    }
    return parts.length === 0 ? 'Not configured' : ['Enabled', ...parts].join(' · ');
}

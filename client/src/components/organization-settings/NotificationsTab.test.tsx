import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider';
import { resolveEdition } from '@/lib/edition';
import { alertSummaryLine, alertSummaryPath, type AlertSummary } from '@/types/alerts';

/**
 * What each role sees on the Notifications tab. A member gets the channel
 * description and the read-only state line from `…/notifications/summary`
 * and no controls; an owner or admin keeps the editing UI. Rendered to
 * static markup like the other component tests: `useResource` is mocked per
 * URL, so the component sees the responses it would get from the BFF.
 */

const SETTINGS = {
    available: true,
    emailChannel: true,
    plan: 'pro',
    emailEnabled: true,
    minSeverity: 'critical',
    kev: true,
    slack: { configured: true, masked: 'hooks.slack.com/…WXYZ' },
    quietMinutes: 10,
    recipients: [{ email: 'owner@acme.test', name: 'Owner' }],
    recentSends: [],
};

const SUMMARY: AlertSummary = {
    available: true,
    emailChannel: true,
    emailEnabled: true,
    recipientCount: 3,
    webhookConfigured: true,
    webhookHost: 'hooks.slack.com',
};

const responses = new Map<string, unknown>();

vi.mock('@/hooks', () => ({
    useResource: (url: string | null, opts?: { select?: (body: unknown) => unknown }) => {
        const body = url ? responses.get(url) : undefined;
        const data = body === undefined ? null : opts?.select ? opts.select(body) : body;
        return { data, error: null, isLoading: false, isRefreshing: false, lastUpdated: null, refetch: async () => {} };
    },
}));

const { NotificationsTab } = await import('./NotificationsTab');

const ORG = 'org-1';

function render(canManage: boolean, editionName: 'cloud' | 'community' = 'cloud') {
    return renderToStaticMarkup(
        <RuntimeConfigProvider
            config={{
                scannerChartVersion: null,
                publicApiUrl: null,
                demoMode: false,
                edition: resolveEdition(editionName),
                localLogin: false,
            }}
        >
            <NotificationsTab orgId={ORG} canManage={canManage} />
        </RuntimeConfigProvider>,
    );
}

describe('NotificationsTab', () => {
    it('shows a member the channels and the read-only state line, with no controls', () => {
        responses.clear();
        responses.set(alertSummaryPath(ORG), SUMMARY);
        responses.set(`/api/organizations/${ORG}`, { organization: { weeklyDigestEnabled: true } });

        const html = render(false);
        expect(html).toContain('Delivered to a Slack incoming webhook and by email.');
        expect(html).toContain('Enabled · Slack: hooks.slack.com · email to 3 owners and admins');
        expect(html).toContain('Only owners and admins can change this.');
        // Nothing an admin would use: no radio group, no webhook form, no test button.
        expect(html).not.toContain('alert-min-severity');
        expect(html).not.toContain('Add webhook');
        expect(html).not.toContain('Send a test');
        // And nothing the summary endpoint does not carry.
        expect(html).not.toContain('owner@acme.test');
        expect(html).not.toContain('…WXYZ');
    });

    it('keeps the editing UI for an owner or admin', () => {
        responses.clear();
        responses.set(`/api/organizations/${ORG}/alerts`, SETTINGS);
        responses.set(`/api/organizations/${ORG}`, { organization: { weeklyDigestEnabled: true } });

        const html = render(true);
        expect(html).toContain('Delivered to a Slack incoming webhook and by email.');
        expect(html).toContain('alert-min-severity');
        expect(html).toContain('hooks.slack.com/…WXYZ');
        expect(html).toContain('Send a test');
        expect(html).toContain('owner@acme.test');
        expect(html).not.toContain('Only owners and admins can change this.');
    });

    it('names email in the weekly digest heading so the two cards read as different channels', () => {
        responses.clear();
        responses.set(`/api/organizations/${ORG}/alerts`, SETTINGS);
        responses.set(`/api/organizations/${ORG}`, { organization: { weeklyDigestEnabled: true } });

        expect(render(true)).toContain('Weekly digest email');
    });

    it('does not promise email in the community edition, where the webhook is the only channel', () => {
        responses.clear();
        responses.set(alertSummaryPath(ORG), {
            ...SUMMARY,
            emailChannel: false,
            emailEnabled: false,
            recipientCount: 0,
        });

        const html = render(false, 'community');
        expect(html).toContain('Delivered to a Slack incoming webhook.');
        expect(html).not.toContain('and by email.');
        expect(html).toContain('Enabled · Slack: hooks.slack.com');
        expect(html).not.toContain('Weekly digest');
    });
});

describe('alertSummaryLine', () => {
    it('reads "Not configured" when no channel is on', () => {
        expect(alertSummaryLine({ ...SUMMARY, webhookConfigured: false, webhookHost: null, emailEnabled: false })).toBe(
            'Not configured',
        );
    });

    it('calls a non-Slack host a webhook and counts one recipient in the singular', () => {
        expect(alertSummaryLine({ ...SUMMARY, webhookHost: 'acme.webhook.office.com', recipientCount: 1 })).toBe(
            'Enabled · Webhook: acme.webhook.office.com · email to 1 owner or admin',
        );
    });

    it('says when the plan has no alerts', () => {
        expect(alertSummaryLine({ ...SUMMARY, available: false })).toBe('Not included in this plan');
    });
});

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BellRing, Check, Lock, Mail, Send, Trash2 } from 'lucide-react';
import { Badge, Button, LoadingBlock, RelativeTime, Spinner } from '@/components/ui';
import { useResource } from '@/hooks';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { useRuntimeConfig } from '@/components/providers';

/**
 * Notifications — the two push channels the product has, one per card.
 *
 *  - **Critical & KEV alerts.** Within minutes of an advisory landing as a
 *    critical or CISA-KEV finding on an image this organization is running
 *    (or CISA listing one already running), one message per channel: an
 *    incoming webhook (Slack, Teams, Mattermost, Discord — every edition)
 *    and, on the cloud, email to owners and admins. Included in Pro and
 *    Business; the free plan sees the card locked with what it buys. The
 *    community edition has alerts on for its one plan.
 *  - **Weekly digest.** Monday's summary email, on every cloud plan. Not
 *    drawn in the community edition, which sends no email.
 *
 * Both are organization-wide settings, not per person; only owners and
 * admins can change them, and the demo visitor sees them read-only.
 */

interface AlertSettings {
    available: boolean;
    /** Whether the email channel exists at all (`edition.alerting === "full"` on the server). */
    emailChannel: boolean;
    plan: string;
    emailEnabled: boolean;
    minSeverity: 'critical' | 'high' | 'none';
    kev: boolean;
    slack: { configured: boolean; masked: string | null };
    quietMinutes: number;
    recipients: { email: string; name: string | null }[];
    recentSends: {
        id: string;
        channel: 'email' | 'slack';
        recipient: string;
        subject: string;
        advisoryCount: number;
        kind: 'alert' | 'test';
        status: string;
        error: string | null;
        sentAt: string;
    }[];
}

type ChannelOutcome = { status: 'sent' } | { status: 'failed'; error: string } | { status: 'not_configured' };

function Toggle({
    on,
    disabled,
    onClick,
    label,
}: {
    on: boolean;
    disabled: boolean;
    onClick: () => void;
    label: string;
}) {
    return (
        <label className="inline-flex items-center gap-3 text-sm text-ink">
            <button
                type="button"
                role="switch"
                aria-checked={on}
                disabled={disabled}
                onClick={onClick}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    on ? 'bg-accent-emphasis' : 'bg-edge-strong'
                }`}
            >
                <span
                    aria-hidden="true"
                    className={`inline-block size-4 rounded-full bg-surface-raised shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}
                />
            </button>
            {label}
        </label>
    );
}

const STATUS_VARIANT: Record<string, 'success' | 'danger' | 'neutral' | 'attention'> = {
    sent: 'success',
    delivered: 'success',
    delayed: 'attention',
    bounced: 'danger',
    complained: 'danger',
    failed: 'danger',
};

export function NotificationsTab({ orgId, canManage }: { orgId: string; canManage: boolean }) {
    const { edition } = useRuntimeConfig();
    const hasEmail = edition.alerting === 'full';
    const { data, error, refetch } = useResource<AlertSettings>(
        canManage ? `/api/organizations/${orgId}/alerts` : null,
        {
            fallbackError: 'Could not load the alert settings',
        },
    );
    const { data: digestEnabled, refetch: refetchDigest } = useResource<boolean>(
        hasEmail ? `/api/organizations/${orgId}` : null,
        {
            select: (body) =>
                (body as { organization?: { weeklyDigestEnabled?: boolean } }).organization?.weeklyDigestEnabled ??
                true,
        },
    );

    const [busy, setBusy] = useState<null | 'email' | 'slack' | 'remove' | 'test' | 'digest' | 'criteria'>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [webhook, setWebhook] = useState('');
    const [testResult, setTestResult] = useState<Record<'email' | 'slack', ChannelOutcome> | null>(null);

    const patchAlerts = async (body: Record<string, unknown>, what: 'email' | 'slack' | 'remove' | 'criteria') => {
        setBusy(what);
        setActionError(null);
        setTestResult(null);
        try {
            await apiFetch(`/api/organizations/${orgId}/alerts`, { method: 'PATCH', json: body });
            if (what === 'slack') setWebhook('');
            await refetch();
        } catch (err) {
            setActionError(errorMessage(err, 'Failed to update'));
        } finally {
            setBusy(null);
        }
    };

    const sendTest = async () => {
        setBusy('test');
        setActionError(null);
        try {
            const body = await apiFetch<Record<'email' | 'slack', ChannelOutcome>>(
                `/api/organizations/${orgId}/alerts/test`,
                { method: 'POST' },
            );
            setTestResult(body);
            await refetch();
        } catch (err) {
            setActionError(errorMessage(err, 'The test could not be sent'));
        } finally {
            setBusy(null);
        }
    };

    const toggleDigest = async () => {
        if (digestEnabled === null) return;
        setBusy('digest');
        setActionError(null);
        try {
            await apiFetch(`/api/organizations/${orgId}`, {
                method: 'PATCH',
                json: { weeklyDigestEnabled: !digestEnabled },
            });
            await refetchDigest();
        } catch (err) {
            setActionError(errorMessage(err, 'Failed to update the weekly digest setting'));
        } finally {
            setBusy(null);
        }
    };

    const available = data?.available ?? false;
    const canEditAlerts = canManage && available;

    return (
        <div className="space-y-6">
            {/* Critical & KEV alerts */}
            <div className="rounded-md bg-surface-raised border border-edge p-6">
                <div className="flex items-start justify-between gap-4 mb-2">
                    <h3 className="text-lg font-medium text-ink flex items-center gap-2">
                        <BellRing className="size-5 text-ink-muted" aria-hidden="true" />
                        Critical &amp; KEV alerts
                    </h3>
                    {data && !available && (
                        <Badge variant="attention" pill>
                            <Lock className="size-3" aria-hidden="true" />
                            Pro
                        </Badge>
                    )}
                </div>
                <p className="text-sm text-ink-muted mb-4">
                    When an advisory the mirror just learned about lands as a <strong>critical</strong> or{' '}
                    <strong>CISA KEV</strong> finding on an image you are running — or CISA lists one that is already
                    running — you hear about it within minutes: one message naming the advisory, the packages, the
                    running images and their clusters. A burst of scans is folded into one message. A deploy that ships
                    a critical is not an alert; the Feed shows it.
                    {!hasEmail &&
                        ' Messages go to the webhook you add below; email digests and routing are a StackRadar Cloud feature.'}
                </p>

                {!canManage && <p className="text-xs text-ink-muted">Only owners and admins can see or change this.</p>}

                {canManage && !data && !error && <LoadingBlock label="Loading…" className="py-4" />}
                {error && <p className="text-sm text-danger">{error}</p>}

                {data && !available && (
                    <div className="rounded-md border border-attention-muted bg-attention-subtle p-4 text-sm text-ink">
                        <p>
                            Alerts are included in <strong>Pro</strong> and <strong>Business</strong>. Your organization
                            is on the free plan{hasEmail ? ', which gets the weekly digest below' : ''}.
                        </p>
                        {edition.billing && (
                            <Link
                                href="/org-settings?tab=billing"
                                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                            >
                                See plans
                            </Link>
                        )}
                    </div>
                )}

                {data && available && (
                    <div className="space-y-6">
                        {/* What is alerted — the org's criteria, shared by both channels. */}
                        <div>
                            <h4 className="text-sm font-medium text-ink mb-2">What to alert on</h4>
                            <fieldset className="space-y-2" disabled={!canEditAlerts || busy !== null}>
                                <legend className="sr-only">Severity floor</legend>
                                {(
                                    [
                                        [
                                            'critical',
                                            'Critical findings',
                                            'The default. Anything below critical waits for the weekly digest.',
                                        ],
                                        [
                                            'high',
                                            'High and critical findings',
                                            'More messages; a busy fleet can see several a week.',
                                        ],
                                        [
                                            'none',
                                            'No severity rule',
                                            'Only known-exploited findings, whatever their severity.',
                                        ],
                                    ] as const
                                ).map(([value, label, hint]) => (
                                    <label
                                        key={value}
                                        className="flex items-start gap-3 text-sm text-ink cursor-pointer"
                                    >
                                        <input
                                            type="radio"
                                            name="alert-min-severity"
                                            value={value}
                                            checked={data.minSeverity === value}
                                            onChange={() => patchAlerts({ minSeverity: value }, 'criteria')}
                                            className="mt-1 accent-accent-emphasis"
                                        />
                                        <span>
                                            {label}
                                            <span className="block text-xs text-ink-muted">{hint}</span>
                                        </span>
                                    </label>
                                ))}
                                <label className="flex items-start gap-3 text-sm text-ink cursor-pointer pt-1">
                                    <input
                                        type="checkbox"
                                        checked={data.kev}
                                        onChange={() => patchAlerts({ kev: !data.kev }, 'criteria')}
                                        className="mt-1 accent-accent-emphasis"
                                    />
                                    <span>
                                        Known-exploited findings (CISA KEV), any severity
                                        <span className="block text-xs text-ink-muted">
                                            Includes CISA listing something you were already running — nothing changed
                                            in your cluster, but the world learned it is being exploited.
                                        </span>
                                    </span>
                                </label>
                            </fieldset>
                            {busy === 'criteria' && <Spinner size="sm" />}
                        </div>

                        {/* Email channel — the cloud's. */}
                        {data.emailChannel && (
                            <div>
                                <h4 className="text-sm font-medium text-ink flex items-center gap-2 mb-2">
                                    <Mail className="size-4 text-ink-muted" aria-hidden="true" />
                                    Email
                                </h4>
                                <Toggle
                                    on={data.emailEnabled}
                                    disabled={!canEditAlerts || busy !== null}
                                    onClick={() => patchAlerts({ emailEnabled: !data.emailEnabled }, 'email')}
                                    label={
                                        data.emailEnabled
                                            ? `On — to ${data.recipients.length} ${data.recipients.length === 1 ? 'owner or admin' : 'owners and admins'}`
                                            : 'Off'
                                    }
                                />
                                {busy === 'email' && <Spinner size="sm" />}
                                {data.emailEnabled && data.recipients.length > 0 && (
                                    <p className="mt-2 text-xs text-ink-muted">
                                        {data.recipients.map((r) => r.email).join(', ')}
                                    </p>
                                )}
                                <p className="mt-2 text-xs text-ink-muted">
                                    Every alert email carries an unsubscribe link that switches this channel off for the
                                    organization; it is the same as this toggle.
                                </p>
                            </div>
                        )}

                        {/* The webhook — every edition's channel. Stored on the
                            `alert_slack_webhook_url` column and sent as `{ text }`,
                            which Slack, Teams, Mattermost and Discord all accept. */}
                        <div>
                            <h4 className="text-sm font-medium text-ink flex items-center gap-2 mb-2">
                                <Send className="size-4 text-ink-muted" aria-hidden="true" />
                                Webhook
                            </h4>
                            {data.slack.configured ? (
                                <div className="flex flex-wrap items-center gap-3 text-sm text-ink">
                                    <Check className="size-4 text-success" aria-hidden="true" />
                                    <span>
                                        Posting to <code className="text-xs">{data.slack.masked}</code>
                                    </span>
                                    {canEditAlerts && (
                                        <Button
                                            size="sm"
                                            variant="invisible"
                                            onClick={() => patchAlerts({ slackWebhookUrl: null }, 'remove')}
                                            loading={busy === 'remove'}
                                        >
                                            <Trash2 className="size-4" />
                                            Remove
                                        </Button>
                                    )}
                                </div>
                            ) : (
                                <form
                                    className="flex flex-wrap items-center gap-2"
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        if (webhook.trim())
                                            void patchAlerts({ slackWebhookUrl: webhook.trim() }, 'slack');
                                    }}
                                >
                                    <input
                                        type="url"
                                        inputMode="url"
                                        value={webhook}
                                        onChange={(e) => setWebhook(e.target.value)}
                                        disabled={!canEditAlerts || busy !== null}
                                        placeholder="https://hooks.slack.com/services/…"
                                        aria-label="Incoming webhook URL"
                                        className="block w-full max-w-md rounded-md bg-surface-raised border border-edge-strong px-3 py-1.5 text-sm text-ink placeholder-ink-faint focus:border-accent focus:ring-1 focus:ring-accent outline-none disabled:opacity-50"
                                    />
                                    <Button
                                        type="submit"
                                        size="sm"
                                        disabled={!canEditAlerts || !webhook.trim()}
                                        loading={busy === 'slack'}
                                    >
                                        Add webhook
                                    </Button>
                                </form>
                            )}
                            <p className="mt-2 text-xs text-ink-muted">
                                An <em>incoming webhook</em> (Slack → Apps → Incoming Webhooks; Teams, Mattermost and
                                Discord&apos;s Slack-compatible webhooks work too). The URL is the credential: it is
                                stored, never shown again in full, and only ever POSTed to, as a JSON{' '}
                                <code className="text-xs">{'{ text }'}</code> message.
                            </p>
                        </div>

                        {/* Test + log */}
                        <div className="flex flex-wrap items-center gap-3">
                            <Button
                                size="sm"
                                onClick={sendTest}
                                disabled={
                                    !canEditAlerts ||
                                    (!(data.emailChannel && data.emailEnabled) && !data.slack.configured)
                                }
                                loading={busy === 'test'}
                            >
                                Send a test
                            </Button>
                            {testResult && (
                                <span className="text-sm text-ink-muted">
                                    {(['email', 'slack'] as const)
                                        .filter((ch) => testResult[ch].status !== 'not_configured')
                                        .map((ch) => {
                                            const r = testResult[ch];
                                            return `${ch === 'email' ? 'Email' : 'Webhook'}: ${r.status === 'sent' ? 'sent' : `failed — ${'error' in r ? r.error : ''}`}`;
                                        })
                                        .join(' · ')}
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-ink-muted">
                            Messages go out once a burst of findings has been quiet for {data.quietMinutes} minutes, so
                            one advisory across forty images is one message.
                        </p>

                        {data.recentSends.length > 0 && (
                            <div>
                                <h4 className="text-sm font-medium text-ink mb-2">Recent deliveries</h4>
                                <ul className="divide-y divide-edge text-sm">
                                    {data.recentSends.map((s) => (
                                        <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                                            <Badge variant={STATUS_VARIANT[s.status] ?? 'neutral'}>{s.status}</Badge>
                                            <span className="text-ink-muted">
                                                {s.channel === 'email' ? 'Email' : 'Webhook'}
                                            </span>
                                            <span className="text-ink">
                                                {s.kind === 'test' ? 'Test message' : s.subject}
                                            </span>
                                            <span className="text-ink-muted">→ {s.recipient}</span>
                                            <span className="ml-auto text-xs text-ink-muted">
                                                <RelativeTime date={new Date(s.sentAt)} />
                                            </span>
                                            {s.error && (
                                                <span className="basis-full text-xs text-danger">{s.error}</span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}
                {actionError && <p className="mt-3 text-sm text-danger">{actionError}</p>}
            </div>

            {/* Weekly digest — on every cloud plan; the community edition sends no email. */}
            {hasEmail && (
                <div className="rounded-md bg-surface-raised border border-edge p-6">
                    <h3 className="text-lg font-medium text-ink mb-2">Weekly digest</h3>
                    <p className="text-sm text-ink-muted mb-4">
                        Every Monday, owners and admins get one email with the Radar Score and where it moved, the
                        findings to fix first, new CISA KEV matches and any registry the scanner cannot pull from. Off
                        for the whole organization, not per person; the link at the bottom of the email does the same.
                    </p>
                    <div className="flex items-center gap-3">
                        <Toggle
                            on={digestEnabled ?? true}
                            disabled={!canManage || busy !== null || digestEnabled === null}
                            onClick={toggleDigest}
                            label={
                                digestEnabled === null ? 'Loading…' : digestEnabled ? 'On — sent every Monday' : 'Off'
                            }
                        />
                        {busy === 'digest' && <Spinner size="sm" />}
                    </div>
                    {!canManage && (
                        <p className="mt-2 text-xs text-ink-muted">Only owners and admins can change this.</p>
                    )}
                </div>
            )}
        </div>
    );
}

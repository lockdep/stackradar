'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ApiError, apiFetch, errorMessage } from '@/lib/api-client';
import { PASSWORD_MIN_LENGTH } from '@/lib/local-login';

const INPUT =
    'block w-full rounded-md bg-surface-raised border border-edge-strong px-3 py-2 text-ink placeholder-ink-faint focus:border-accent focus:ring-1 focus:ring-accent outline-none';

/**
 * Current password, new password twice. Posts to `/api/account/password`;
 * a forced change then goes to `/` with a full navigation, so the proxy
 * re-reads the session and lets the app through. Mirrors the server's
 * policy (`passwordPolicyProblem`) only as `minLength` on the field — the
 * route is the rule, this is the hint.
 */
export function ChangePasswordForm({ mustChange }: { mustChange: boolean }) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        if (next !== confirm) {
            setError('The new passwords do not match.');
            return;
        }
        setBusy(true);
        try {
            /* A wrong current password is a 403 from this route, never a 401 —
               so the default session-lost handling on 401 is the right one here. */
            await apiFetch('/api/account/password', {
                method: 'POST',
                json: { currentPassword: current, newPassword: next },
            });
            if (mustChange) {
                // A full navigation on purpose: the proxy gate reads the session
                // row per request, and the SessionProvider's copy still says
                // `mustChangePassword`; a client-side push would keep it.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.assign('/');
                return;
            }
            setDone(true);
            setCurrent('');
            setNext('');
            setConfirm('');
        } catch (err) {
            setError(
                err instanceof ApiError && err.status === 0
                    ? 'Could not reach the server.'
                    : errorMessage(err, 'Could not change the password.'),
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
                <label htmlFor="current-password" className="block text-sm font-medium text-ink-secondary mb-1">
                    Current password
                </label>
                <input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    className={INPUT}
                    disabled={busy}
                />
            </div>
            <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-ink-secondary mb-1">
                    New password
                </label>
                <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    className={INPUT}
                    disabled={busy}
                />
                <p className="mt-1 text-xs text-ink-muted">
                    At least {PASSWORD_MIN_LENGTH} characters. Length is the rule; there is no character mix to satisfy.
                </p>
            </div>
            <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-ink-secondary mb-1">
                    New password, again
                </label>
                <input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className={INPUT}
                    disabled={busy}
                />
            </div>

            {error && (
                <div role="alert" className="bg-danger-subtle border border-danger-muted/30 rounded-md p-3">
                    <p className="text-sm text-danger">{error}</p>
                </div>
            )}
            {done && (
                <div role="status" className="bg-success-subtle border border-success-muted/30 rounded-md p-3">
                    <p className="text-sm text-success">Password changed. Your other sessions were signed out.</p>
                </div>
            )}

            <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} className="h-11">
                {mustChange ? 'Set password and continue' : 'Change password'}
            </Button>
        </form>
    );
}

// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui';
import { apiFetch, errorMessage } from '@/lib/api-client';

const termsOkKey = (userId: string) => `sr_terms_accepted_${userId}`;

/* The cache is read on every render and written only by this hook, so there
   is nothing to subscribe to; `useSyncExternalStore` is for the server
   snapshot, which keeps the server render and hydration on "not cached". */
const subscribeToNothing = () => () => {};

export type TermsGateState = 'checking' | 'needed' | 'clear';

/**
 * Blocks the app until the user has accepted the current terms version. The
 * server owns which version is required (GET /api/users/terms, the cloud's
 * `terms/` routes); this hook only renders its answer. New users never see
 * the gate — acceptance is recorded server-side at signup and invite
 * acceptance — so it appears only when the required version has moved past
 * the one a user accepted.
 *
 * The accepted version is cached per user in localStorage so returning users
 * render the app without waiting on the check; the fetch still runs to correct
 * the cache (e.g. the required version was bumped).
 *
 * Fails open like the onboarding gate: a failed check renders the app rather
 * than a locked door. The terms' continued-use clause is the fallback for
 * that path; the gate re-runs on next load.
 *
 * `skip` is the live demo and the community edition: the visitor is not a
 * party to the terms (the demo's accept call would be refused as read-only,
 * the community's route does not exist), so the gate is clear from the start
 * rather than a door that cannot open.
 */
export function useTermsGate(userId: string | null, skip = false) {
    /* The server's answer, keyed by the user it was given for; another user's
       answer does not read, so a change of user needs no reset. */
    const [verdict, setVerdict] = useState<{ userId: string; gate: 'needed' | 'clear' } | null>(null);
    const [isAccepting, setIsAccepting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const cached = useSyncExternalStore(
        subscribeToNothing,
        () => (userId ? localStorage.getItem(termsOkKey(userId)) !== null : false),
        () => false,
    );
    const gate: TermsGateState = skip
        ? 'clear'
        : verdict && verdict.userId === userId
          ? verdict.gate
          : cached
            ? 'clear'
            : 'checking';

    useEffect(() => {
        if (!userId || skip) return;

        let cancelled = false;
        (async () => {
            try {
                const data = await apiFetch<{ accepted: boolean; requiredVersion: number }>('/api/users/terms');
                if (cancelled) return;
                if (data.accepted) {
                    localStorage.setItem(termsOkKey(userId), String(data.requiredVersion));
                    setVerdict({ userId, gate: 'clear' });
                } else {
                    localStorage.removeItem(termsOkKey(userId));
                    setVerdict({ userId, gate: 'needed' });
                }
            } catch {
                if (!cancelled) setVerdict({ userId, gate: 'clear' });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [userId, skip]);

    const accept = useCallback(async () => {
        if (!userId) return;
        setIsAccepting(true);
        setError(null);
        try {
            const data = await apiFetch<{ acceptedVersion: number }>('/api/users/terms/accept', { method: 'POST' });
            localStorage.setItem(termsOkKey(userId), String(data.acceptedVersion));
            setVerdict({ userId, gate: 'clear' });
        } catch (err) {
            setError(errorMessage(err, 'Failed to record your acceptance'));
        } finally {
            setIsAccepting(false);
        }
    }, [userId]);

    return { gate, accept, isAccepting, error };
}

export function TermsAcceptanceScreen({
    onAccept,
    isAccepting,
    error,
}: {
    onAccept: () => void;
    isAccepting: boolean;
    error: string | null;
}) {
    return (
        <div className="min-h-screen bg-surface flex items-center justify-center">
            <div className="text-center max-w-md px-6">
                <h1 className="text-2xl font-bold text-ink mb-2">StackRadar</h1>
                <h2 className="text-lg font-semibold text-ink mb-2">Review our updated terms</h2>
                <p className="text-sm text-ink-muted mb-6">
                    To keep using StackRadar, please review and accept the current{' '}
                    <a
                        href="https://stackradar.io/terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline transition-colors"
                    >
                        Terms of Service
                    </a>{' '}
                    and{' '}
                    <a
                        href="https://stackradar.io/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline transition-colors"
                    >
                        Privacy Policy
                    </a>
                    .
                </p>

                {error && (
                    <div className="bg-danger-subtle border border-danger-muted rounded-md p-3 mb-4 text-left">
                        <p className="text-sm text-danger">{error}</p>
                    </div>
                )}

                <Button variant="primary" size="lg" onClick={onAccept} loading={isAccepting}>
                    {isAccepting ? 'Saving...' : 'Agree and continue'}
                </Button>
            </div>
        </div>
    );
}

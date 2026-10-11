'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { ACTIVE_ORG_COOKIE } from '@/lib/constants';
import { useRuntimeConfig } from '@/components/providers';

interface AcceptInviteCardProps {
    token: string;
    orgName: string;
    role: 'admin' | 'member';
    inviteEmail: string;
    sessionEmail: string;
}

export function AcceptInviteCard({ token, orgName, role, inviteEmail, sessionEmail }: AcceptInviteCardProps) {
    const [isAccepting, setIsAccepting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { edition } = useRuntimeConfig();

    const emailMismatch = sessionEmail.toLowerCase() !== inviteEmail.toLowerCase();

    const handleAccept = async () => {
        setIsAccepting(true);
        setError(null);

        try {
            const data = await apiFetch<{ organization?: { id: string } }>(`/api/invites/${token}/accept`, {
                method: 'POST',
            });

            // Make the joined org active so the app opens into it
            if (data.organization?.id) {
                const oneYear = 60 * 60 * 24 * 365;
                document.cookie = `${ACTIVE_ORG_COOKIE}=${encodeURIComponent(data.organization.id)}; path=/; max-age=${oneYear}; samesite=lax`;
            }

            // A full navigation, not `router.push`: `OrganizationProvider` lives in
            // the root layout and loads memberships once on mount, so a client-side
            // transition would open the app without the org just joined.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- the reload is the point, see above
            window.location.href = '/';
        } catch (err) {
            setError(errorMessage(err, 'Failed to accept invite'));
            setIsAccepting(false);
        }
    };

    return (
        <div className="text-center">
            <h2 className="text-xl font-semibold text-ink mb-2">Join {orgName}</h2>
            <p className="text-sm text-ink-secondary mb-8">
                You&apos;ve been invited to join <span className="font-medium text-ink">{orgName}</span> as{' '}
                {role === 'admin' ? 'an admin' : 'a member'}.
            </p>

            {/* The link is the credential, not the email: an invite sent to a
                work address is routinely opened from a GitHub account with a
                personal one. Say which account is joining so that is a choice,
                not a surprise. */}
            {emailMismatch && (
                <p className="text-sm text-ink-muted -mt-4 mb-8">
                    This invite was sent to <span className="font-medium text-ink">{inviteEmail}</span>. You&apos;ll
                    join as <span className="font-medium text-ink">{sessionEmail}</span>.
                </p>
            )}

            {error && (
                <div className="bg-danger-subtle border border-danger-muted/30 rounded-md p-3 mb-4 text-left">
                    <p className="text-sm text-danger">{error}</p>
                </div>
            )}

            <Button variant="primary" size="lg" fullWidth onClick={handleAccept} loading={isAccepting}>
                {isAccepting ? 'Joining...' : 'Accept invite'}
            </Button>

            {/* Accepting is recorded server-side as acceptance of the current
                terms version (on the cloud), so the notice has to sit next to
                the button. The community edition has no terms. */}
            {edition.isCloud && (
                <p className="mt-4 text-xs text-ink-muted">
                    By accepting, you agree to our{' '}
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
                </p>
            )}
        </div>
    );
}

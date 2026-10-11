'use client';

import { useEffect } from 'react';
import { setAnalyticsClient } from '@/lib/analytics';

/**
 * Initialises PostHog (EU cloud, via the /ingest first-party proxy).
 *
 * `persistence: "memory"` is deliberate: nothing is written to cookies or
 * localStorage, which keeps the privacy policy's "no identifier on your
 * device" claim true and needs no consent banner. Identity comes from the
 * login instead — `identify(userId)` gives stable per-user analytics across
 * sessions without any device storage.
 *
 * Session replay caveat that follows from memory persistence: the session
 * id lives in memory too, so a hard reload or new tab starts a new replay.
 * Client-side navigation keeps one continuous recording, and every fragment
 * is still attributed to the same identified user.
 *
 * The key arrives as a prop from the server layout rather than via
 * NEXT_PUBLIC_ inlining: dev and prod run the same image, so the key must be
 * read from the environment at runtime. No key → no analytics (local dev,
 * every community install) — and no SDK either: `posthog-js` is
 * `import()`ed only once a key is present, so a build without one does not
 * carry it. A static import put the SDK in a shared chunk of every
 * deployment, keyed or not. Event call sites use `lib/analytics.ts`, which
 * is a no-op until the client below is handed to it.
 *
 * The live demo (`demoMode`) changes two things:
 * every event carries `demo: true` (a super property, registered in `loaded`
 * — which posthog-js runs before the initial `$pageview`) so the signup
 * funnel can exclude it, and `identify` is never called, because a thousand
 * visitors sharing one user id would collapse into one person. Session
 * replay stays on: the demo is where a stranger meets the product for the
 * first time, and where they click, stall and leave is the whole reason it
 * exists. The recording belongs to an anonymous distinct id; with memory
 * persistence every reload starts a new one (see above), which is fine —
 * a demo visit is one tab, one sitting.
 */
export function PostHogProvider({
    apiKey,
    userId,
    userEmail,
    demoMode = false,
    children,
}: {
    apiKey?: string;
    userId?: string;
    userEmail?: string | null;
    demoMode?: boolean;
    children: React.ReactNode;
}) {
    useEffect(() => {
        if (!apiKey) return;
        let cancelled = false;
        void import('posthog-js').then(({ default: posthog }) => {
            if (cancelled) return;
            if (!posthog.__loaded) {
                posthog.init(apiKey, {
                    api_host: '/ingest',
                    ui_host: 'https://eu.posthog.com',
                    defaults: '2025-05-24',
                    persistence: 'memory',
                    // Session replay. Whether recording happens at all is the
                    // per-project "Record user sessions" toggle in the PostHog
                    // dashboard; this block only shapes what a recording holds.
                    // Every input is masked, and elements marked `ph-no-capture`
                    // (one-time cluster API keys) never reach the replay.
                    session_recording: {
                        maskAllInputs: true,
                    },
                    // Console output rides along with the replay — the JS error
                    // next to the rage-click is usually the answer to "why were
                    // they stuck".
                    enable_recording_console_log: true,
                    loaded: (client) => {
                        if (demoMode) client.register({ demo: true });
                    },
                });
            }
            setAnalyticsClient(posthog);
            if (userId && !demoMode) {
                posthog.identify(userId, userEmail ? { email: userEmail } : undefined);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [apiKey, userId, userEmail, demoMode]);

    return <>{children}</>;
}

'use client';

import { useEffect } from 'react';
import { setAnalyticsClient } from '@/lib/analytics';

/**
 * Initialises PostHog (EU cloud, via the /ingest first-party proxy).
 *
 * `persistence: "localStorage+cookie"` on the dashboard, since 2026-11-01.
 * Until then it was `"memory"` — nothing on the device, which kept the
 * privacy policy's "no identifier on your device" line true — and the price
 * was that the dashboard's visitor and the marketing site's were never the
 * same PostHog person, so no landing→sign-up funnel could be read (the
 * 1 Nov 2026 marketing audit). The id now lives in localStorage with a
 * first-party cookie on `.stackradar.io` (posthog-js's
 * `cross_subdomain_cookie` default), shared with stackradar.io;
 * `identify(userId)` at login merges that anonymous person into the user's,
 * and `resetAnalytics()` (lib/analytics.ts) clears it at sign-out so the
 * next person on the device starts anonymous. The marketing site's privacy
 * policy (§analytics, §cookies) describes the cookie. A community install
 * never gets here: no key, no SDK.
 *
 * The live demo keeps `"memory"`: demo.stackradar.io shares the
 * `.stackradar.io` cookie, so a signed-in user who opens the demo would
 * otherwise carry their identified id into it and every `demo: true` event
 * and replay would land on their person. With memory persistence the SDK
 * never reads the cookie, a demo visit is one anonymous sitting, and the
 * landing→app join is unaffected (the app reads the landing's cookie).
 *
 * Session replay follows the persistence: on the dashboard a hard reload
 * or a new tab continues the same replay; in the demo each starts a new
 * one, which is fine — a demo visit is one tab, one sitting.
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
 * exists. The recording belongs to an anonymous, in-memory distinct id
 * (see above).
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
                    persistence: demoMode ? 'memory' : 'localStorage+cookie',
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

// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { READ_ONLY_DEMO_CODE } from '@/lib/demo';
import { PLAN_REQUIRED_CODE } from './billing/plan-state';

const TOAST_MS = 5000;

/**
 * The two read-only contexts the server refuses writes in, by the `code` it
 * answers with, and what to say for each (`server/src/lib/demo.ts`,
 * `server/src/lib/plan-gate.ts`).
 */
const MESSAGES: Record<string, string> = {
    [READ_ONLY_DEMO_CODE]: 'This is a read-only demo. Sign up to make changes to your own clusters.',
    [PLAN_REQUIRED_CODE]: 'Your organization has no active plan. Start a plan to make changes.',
};

/**
 * Cheap insurance for the read-only contexts: every mutation the UI knows
 * about is left undrawn, but a button that was missed still reaches the
 * server, which answers `403 {code}` — and each surface renders that as its
 * own generic "Failed to …". This wraps `window.fetch` for the page's
 * lifetime and, on one of those answers, says what actually happened.
 *
 * A fetch wrapper rather than a shared helper because there is no shared
 * helper: the surfaces call `fetch` directly, and a patch mounted only in
 * the two contexts (the live demo, an org whose plan ended) is a smaller
 * footprint than threading a hook through fifty call sites. The body is
 * read from a clone so the caller's own `.json()` still works.
 */
export function ReadOnlyToast() {
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        const original = window.fetch;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const show = (text: string) => {
            setMessage(text);
            clearTimeout(timer);
            timer = setTimeout(() => setMessage(null), TOAST_MS);
        };

        window.fetch = async (...args) => {
            const response = await original(...args);
            if (response.status === 403 && response.headers.get('content-type')?.includes('json')) {
                response
                    .clone()
                    .json()
                    .then((body: { code?: string } | null) => {
                        const text = body?.code ? MESSAGES[body.code] : undefined;
                        if (text) show(text);
                    })
                    .catch(() => {});
            }
            return response;
        };
        return () => {
            window.fetch = original;
            clearTimeout(timer);
        };
    }, []);

    if (!message) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md border border-edge bg-surface-overlay px-4 py-2.5 text-sm text-ink shadow-floating"
        >
            <Lock aria-hidden className="size-4 text-ink-muted" />
            {message}
        </div>
    );
}

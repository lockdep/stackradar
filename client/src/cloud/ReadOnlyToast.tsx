// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { READ_ONLY_DEMO_CODE } from '@/lib/demo';

const TOAST_MS = 5000;

/**
 * Cheap insurance for the live demo: every
 * mutation the UI knows about is left undrawn, but a button that was
 * missed still reaches the server, which answers `403 {code:
 * "read_only_demo"}` — and each surface renders that as its own generic
 * "Failed to …". This wraps `window.fetch` for the page's lifetime and, on
 * that exact answer, says what actually happened.
 *
 * A fetch wrapper rather than a shared helper because there is no shared
 * helper: the surfaces call `fetch` directly, and a demo-only patch is a
 * smaller footprint than threading a hook through fifty call sites. Only
 * mounted in demo mode; the body is read from a clone so the caller's own
 * `.json()` still works.
 */
export function DemoReadOnlyToast() {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const original = window.fetch;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const show = () => {
            setVisible(true);
            clearTimeout(timer);
            timer = setTimeout(() => setVisible(false), TOAST_MS);
        };

        window.fetch = async (...args) => {
            const response = await original(...args);
            if (response.status === 403 && response.headers.get('content-type')?.includes('json')) {
                response
                    .clone()
                    .json()
                    .then((body: { code?: string } | null) => {
                        if (body?.code === READ_ONLY_DEMO_CODE) show();
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

    if (!visible) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md border border-edge bg-surface-overlay px-4 py-2.5 text-sm text-ink shadow-floating"
        >
            <Lock aria-hidden className="size-4 text-ink-muted" />
            This is a read-only demo. Sign up to make changes to your own clusters.
        </div>
    );
}

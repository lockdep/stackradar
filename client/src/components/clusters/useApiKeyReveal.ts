'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api-client';

/** How long a revealed key stays on screen before it hides itself again. */
export const REVEAL_VISIBLE_MS = 60_000;

/**
 * `POST /api/clusters/:id/api-key/reveal` — the current scanner key, in
 * plaintext, from its encrypted-at-rest copy. Admin/owner-only on the
 * server and audited there; the two refusals a caller must tell apart come
 * back as `code`.
 */
export class RevealError extends Error {
    constructor(
        message: string,
        public readonly code: 'REVEAL_DISABLED' | 'KEY_NOT_REVEALABLE' | null,
    ) {
        super(message);
        this.name = 'RevealError';
    }
}

export async function revealClusterApiKey(clusterId: string): Promise<string> {
    try {
        const data = await apiFetch<{ apiKey: string }>(`/api/clusters/${clusterId}/api-key/reveal`, {
            method: 'POST',
        });
        return data.apiKey;
    } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        const body = (err.body ?? {}) as { code?: unknown };
        const code = body.code === 'REVEAL_DISABLED' || body.code === 'KEY_NOT_REVEALABLE' ? body.code : null;
        throw new RevealError(err.message, code);
    }
}

/**
 * A revealed key as component state: shown on request, gone again after
 * `REVEAL_VISIBLE_MS` or on `hide`, never written anywhere the page could
 * read it back from. Render it inside a `ph-no-capture` element.
 */
export function useApiKeyReveal(clusterId: string) {
    const [apiKey, setApiKey] = useState<string | null>(null);
    const [isRevealing, setIsRevealing] = useState(false);
    const [error, setError] = useState<RevealError | null>(null);

    useEffect(() => {
        if (!apiKey) return;
        const timer = setTimeout(() => setApiKey(null), REVEAL_VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [apiKey]);

    // A new cluster is a new secret; nothing revealed for the old one carries over.
    useEffect(() => {
        setApiKey(null);
        setError(null);
    }, [clusterId]);

    const reveal = useCallback(async () => {
        setIsRevealing(true);
        setError(null);
        try {
            setApiKey(await revealClusterApiKey(clusterId));
        } catch (err) {
            setError(err instanceof RevealError ? err : new RevealError('Failed to reveal API key', null));
        } finally {
            setIsRevealing(false);
        }
    }, [clusterId]);

    const hide = useCallback(() => setApiKey(null), []);

    return { apiKey, reveal, hide, isRevealing, error };
}

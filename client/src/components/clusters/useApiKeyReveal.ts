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
    // Keyed by cluster: a new cluster is a new secret, so nothing revealed
    // (or refused) for the old one carries over — it simply does not read.
    const [revealed, setRevealed] = useState<Revealed>(nothingRevealed(clusterId));
    const apiKey = revealed.clusterId === clusterId ? revealed.apiKey : null;
    const error = revealed.clusterId === clusterId ? revealed.error : null;
    const [isRevealing, setIsRevealing] = useState(false);

    useEffect(() => {
        if (!apiKey) return;
        const timer = setTimeout(() => setRevealed(nothingRevealed(clusterId)), REVEAL_VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [apiKey, clusterId]);

    const reveal = useCallback(async () => {
        setIsRevealing(true);
        setRevealed((prev) => ({ clusterId, apiKey: prev.clusterId === clusterId ? prev.apiKey : null, error: null }));
        try {
            setRevealed({ clusterId, apiKey: await revealClusterApiKey(clusterId), error: null });
        } catch (err) {
            const error = err instanceof RevealError ? err : new RevealError('Failed to reveal API key', null);
            setRevealed((prev) => ({ clusterId, apiKey: prev.clusterId === clusterId ? prev.apiKey : null, error }));
        } finally {
            setIsRevealing(false);
        }
    }, [clusterId]);

    const hide = useCallback(() => setRevealed(nothingRevealed(clusterId)), [clusterId]);

    return { apiKey, reveal, hide, isRevealing, error };
}

type Revealed = { clusterId: string; apiKey: string | null; error: RevealError | null };

function nothingRevealed(clusterId: string): Revealed {
    return { clusterId, apiKey: null, error: null };
}

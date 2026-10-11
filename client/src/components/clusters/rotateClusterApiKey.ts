import { apiFetch } from '@/lib/api-client';

/**
 * Generates a new scanner API key and revokes the existing one, returning the
 * plaintext key — the only time it is ever readable.
 *
 * Shared by the Containers and Settings tabs, both of which open
 * `ConnectClusterDialog`.
 */
export async function rotateClusterApiKey(clusterId: string): Promise<string> {
    const data = await apiFetch<{ apiKey: string }>(`/api/clusters/${clusterId}/api-key`, { method: 'POST' });
    return data.apiKey;
}

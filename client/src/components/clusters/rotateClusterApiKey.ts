/**
 * Generates a new scanner API key and revokes the existing one, returning the
 * plaintext key — the only time it is ever readable.
 *
 * Shared by the Containers and Settings tabs, both of which open
 * `ConnectClusterDialog`.
 */
export async function rotateClusterApiKey(clusterId: string): Promise<string> {
    const response = await fetch(`/api/clusters/${clusterId}/api-key`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Failed to generate API key')
    return data.apiKey as string
}

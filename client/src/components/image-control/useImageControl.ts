'use client'

import { useCallback, useState } from 'react'
import { useResource } from '@/hooks'
import type { ImageControlResponse, RuleChange } from '@/lib/image-control'

/**
 * The org's image repositories with what was detected and what the org has
 * said — shared by the Dashboard's set-up banner and the Image ownership
 * settings tab. Admin/owner only on the server; pass `enabled: false` for a
 * member and nothing is fetched.
 */
export function useImageControl(orgId: string | undefined, enabled: boolean) {
    const url = enabled && orgId ? `/api/organizations/${orgId}/image-control` : null
    const { data, error, refetch } = useResource<ImageControlResponse>(url, {
        fallbackError: 'Could not load your image repositories',
    })
    const [saved, setSaved] = useState<ImageControlResponse | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)

    const save = useCallback(
        async (changes: RuleChange[]): Promise<boolean> => {
            if (!orgId || changes.length === 0) return true
            setIsSaving(true)
            setSaveError(null)
            try {
                const res = await fetch(`/api/organizations/${orgId}/image-control-rules`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rules: changes }),
                })
                const body = await res.json().catch(() => null)
                if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
                setSaved({ repositories: body.repositories, unknownCount: body.unknownCount })
                return true
            } catch (err) {
                setSaveError(err instanceof Error ? err.message : 'Could not save')
                return false
            } finally {
                setIsSaving(false)
            }
        },
        [orgId]
    )

    // The save's own response is the freshest list; a later refetch replaces it.
    return { data: saved ?? data, error, isSaving, saveError, save, refetch }
}

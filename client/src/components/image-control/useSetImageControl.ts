'use client'

import { useCallback, useState } from 'react'
import { isAdminOrOwner, useOrganization } from '@/components/providers/OrganizationProvider'
import { useRuntimeConfig } from '@/components/providers'

export type ControlChoice = 'built' | 'third-party' | null

type Repository = { registry: string | null; repository: string | null }

/**
 * Correcting a row's Organization / Third-party tag from a list.
 *
 * The answer is the org's, per repository, and only an owner or admin may
 * give it — the demo's read-only server refuses it — so `setControl` is
 * `undefined` for everyone else and the lists render the plain tag. One
 * answer moves every image of the repository and the filter's counts with
 * them, which is why the caller refetches (`onSaved`) rather than patching a
 * row. `null` resets the repository to what was detected.
 */
export function useSetImageControl(onSaved: () => unknown) {
    const { organization } = useOrganization()
    const { demoMode } = useRuntimeConfig()
    const [error, setError] = useState<string | null>(null)
    const orgId = organization?.id
    const allowed = isAdminOrOwner(organization) && !demoMode

    const setControl = useCallback(
        async ({ registry, repository }: Repository, next: ControlChoice) => {
            if (!orgId || !repository) return
            setError(null)
            try {
                const res = await fetch(`/api/organizations/${orgId}/image-control-rules`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rules: [{ registry, repository, control: next }] }),
                })
                if (!res.ok) {
                    const body = await res.json().catch(() => null)
                    throw new Error(body?.error ?? `Request failed (${res.status})`)
                }
                await onSaved()
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not save')
            }
        },
        [orgId, onSaved],
    )

    return { setControl: allowed ? setControl : undefined, error }
}

import { useCallback, useEffect, useState } from 'react'
import { useResource } from '@/hooks'

/**
 * Loads a tab's payload, and owns reloading it. A thin skin over
 * `useResource` that adds the admin shell's contract: the shared refresh
 * button's `refreshKey`, the shell spinner's `onLoadingChange`, and a
 * `reloadKey` for children that must reload in lockstep.
 *
 * `refetch` is what the TabShell Retry button needs — every tab used to pass a
 * no-op, so a failed load offered a link that did nothing. Reloading is the
 * hook's business, not each caller's: the fetch lives here, so the trigger does
 * too.
 *
 * `reloadKey` is that trigger made visible, for children that must reload in
 * lockstep with the tab (the OSV tab's parse-failures table is the only one).
 */
export function useTabData<T>(url: string, refreshKey: number, onLoadingChange: (v: boolean) => void) {
    const [nonce, setNonce] = useState(0)

    /* Both triggers only ever increment, so their sum is a valid single key. */
    const { data, isLoading, error } = useResource<T>(url, {
        refreshKey: refreshKey + nonce,
        cache: 'no-store',
        loadingOnRefetch: true,
    })

    const refetch = useCallback(() => setNonce((n) => n + 1), [])

    useEffect(() => {
        onLoadingChange(isLoading)
    }, [isLoading, onLoadingChange])

    return { data, isLoading, error, refetch, reloadKey: refreshKey + nonce }
}

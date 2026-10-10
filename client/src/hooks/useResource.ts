'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { reloadIfSessionLost } from '@/lib/session-lost'
import { useRevalidateOnFocus } from './useRevalidateOnFocus'

export type UseResourceOptions<T> = {
    /**
     * Gate the automatic fetch — a lazy tab passes its `active` flag. `refetch`
     * still works while disabled, so a mutation can refresh a not-yet-shown tab.
     */
    enabled?: boolean
    /** External reload trigger — bump it to refetch (the admin tabs' refresh button). */
    refreshKey?: number
    /** Passed through to `fetch` — the admin tabs use `'no-store'`. */
    cache?: RequestCache
    /** Map the parsed response body onto the hook's data (pluck an array, reshape, …). */
    select?: (body: unknown) => T
    /**
     * Message for a non-OK response. The default reads the API's `{ error }`
     * envelope and falls back to `HTTP <status>`.
     */
    responseError?: (res: Response, body: unknown) => string
    /** Message when a failure carries no message of its own. Default `'Failed to load'`. */
    fallbackError?: string
    /**
     * Re-enter the full loading state on every fetch (the admin tabs' shell
     * spinner), not just the first. Off by default: a refetch keeps the data on
     * screen and reports through `isRefreshing` instead.
     */
    loadingOnRefetch?: boolean
    /** Refetch when the user returns to a stale tab — see `useRevalidateOnFocus`. */
    revalidateOnFocus?: boolean
}

export type UseResourceResult<T> = {
    data: T | null
    error: string | null
    /** True until the first fetch settles (and during refetches with `loadingOnRefetch`). */
    isLoading: boolean
    /** True while any fetch is in flight, the first included. */
    isRefreshing: boolean
    /** When data last landed; refetch failures leave it (and `data`) untouched. */
    lastUpdated: Date | null
    refetch: () => Promise<void>
}

/**
 * One GET as React state: `data`, `error`, the loading flags, and a `refetch`.
 *
 * This is the single fetch-into-state hook — the clusters and workloads lists,
 * the admin tabs and the Fixes page all sit on it, differing only in options. It
 * deliberately stops at plain `fetch` + `useState` (no cache, no dedupe): the
 * app's lists are small and the BFF is the only upstream, so a query library
 * would be machinery without a tenant.
 *
 * A `null` url means "nothing to fetch yet" (a drill-down level that is not
 * open); the hook stays idle until it becomes a string. Responses land
 * latest-wins, so a slow page 1 can never overwrite a fast page 2, and nothing
 * lands after unmount.
 */
export function useResource<T>(
    url: string | null,
    options: UseResourceOptions<T> = {}
): UseResourceResult<T> {
    const { enabled = true, refreshKey, revalidateOnFocus = false } = options

    const [data, setData] = useState<T | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(enabled && url !== null)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

    /* The url and options live in refs so `refetch` keeps a stable identity —
       callers pass inline `select`/`responseError` closures, and a refetch
       must read the values of *now*, not of the render that created it. */
    const urlRef = useRef(url)
    const optionsRef = useRef(options)
    useEffect(() => {
        urlRef.current = url
        optionsRef.current = options
    })

    /* Latest-wins ticket: a response only lands while it is still the newest
       request and the hook is still mounted. */
    const fetchIdRef = useRef(0)
    const mountedRef = useRef(true)
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const refetch = useCallback(async () => {
        const target = urlRef.current
        if (target === null) return
        const opts = optionsRef.current
        const id = ++fetchIdRef.current
        const live = () => mountedRef.current && fetchIdRef.current === id

        setIsRefreshing(true)
        setError(null)
        if (opts.loadingOnRefetch) setIsLoading(true)

        try {
            const res = await fetch(target, opts.cache ? { cache: opts.cache } : undefined)
            /* 401 means the session behind the page is gone (see
               `reloadIfSessionLost`); once the reload is on its way there is
               no state worth setting. */
            if (res.status === 401 && (await reloadIfSessionLost())) return
            const body: unknown = await res.json().catch(() => (res.ok ? undefined : {}))
            if (!res.ok) {
                throw new Error(
                    opts.responseError?.(res, body) ??
                        ((body as { error?: string }).error || `HTTP ${res.status}`)
                )
            }
            /* A 200 that is not JSON is never the API: hand it to the caller
               as data and every `data.x.y` read downstream would throw. */
            if (body === undefined) throw new Error('Unexpected response')
            if (!live()) return
            setData(opts.select ? opts.select(body) : (body as T))
            setLastUpdated(new Date())
        } catch (err) {
            if (!live()) return
            setError(
                err instanceof Error
                    ? err.message
                    : (optionsRef.current.fallbackError ?? 'Failed to load')
            )
        } finally {
            if (live()) {
                setIsLoading(false)
                setIsRefreshing(false)
            }
        }
    }, [])

    useEffect(() => {
        if (!enabled || url === null) return
        void refetch()
    }, [enabled, url, refreshKey, refetch])

    useRevalidateOnFocus(refetch, { lastUpdated, enabled: revalidateOnFocus && !isLoading })

    return { data, error, isLoading, isRefreshing, lastUpdated, refetch }
}

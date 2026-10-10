'use client'

import { useEffect, useRef, useState } from 'react'
import { PALETTE_DEBOUNCE_MS } from '@/lib/constants'
import type { SearchResponse } from './types'

/** Below this the server answers 400, so the client does not ask. */
export const SEARCH_MIN_CHARS = 2

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * The palette's fetch: debounced, aborting the in-flight request on every
 * change, and ignoring any response for a term that is no longer the one in
 * the box. The previous results stay on screen while the next ones load, so
 * typing never flashes an empty list.
 *
 * `enabled` is the dialog being open — closed, nothing fires and the last
 * results are dropped.
 */
export function useSearch(query: string, enabled: boolean): { results: SearchResponse | null; status: SearchStatus } {
    const term = query.trim()
    const [results, setResults] = useState<SearchResponse | null>(null)
    const [status, setStatus] = useState<SearchStatus>('idle')
    /* The term the latest request was made for — a response is only applied
       if it is still this one. The AbortController covers the network side;
       this covers a response that landed after the abort was requested. */
    const latestTerm = useRef('')

    useEffect(() => {
        if (!enabled) {
            latestTerm.current = ''
            setResults(null)
            setStatus('idle')
            return
        }
        if (term.length < SEARCH_MIN_CHARS) {
            latestTerm.current = ''
            setResults(null)
            setStatus('idle')
            return
        }

        latestTerm.current = term
        setStatus('loading')
        const controller = new AbortController()
        const handle = setTimeout(async () => {
            try {
                const params = new URLSearchParams({ q: term })
                const res = await fetch(`/api/search?${params}`, { signal: controller.signal })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const data = (await res.json()) as SearchResponse
                if (latestTerm.current !== term) return
                setResults(data)
                setStatus('ready')
            } catch (error) {
                if (controller.signal.aborted || latestTerm.current !== term) return
                void error
                setStatus('error')
            }
        }, PALETTE_DEBOUNCE_MS)

        return () => {
            clearTimeout(handle)
            controller.abort()
        }
    }, [term, enabled])

    return { results, status }
}

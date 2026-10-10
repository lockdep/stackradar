'use client'

import { useEffect, useState } from 'react'

/** Often enough that "just now" never outlives the minute it is true for. */
export const DEFAULT_TICK_MS = 30_000

/**
 * The current time as state, re-issued on an interval while the tab is visible.
 *
 * Exists so that relative labels ("Heartbeat just now") and age-derived colours
 * re-derive themselves from a timestamp already on screen. Nothing is fetched;
 * the return value is only ever read as "re-render now" — consumers keep
 * calling `Date.now()` inside their formatters as before.
 */
export function useNow(tickMs = DEFAULT_TICK_MS): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null
        const stop = () => {
            if (timer !== null) {
                clearInterval(timer)
                timer = null
            }
        }
        const sync = () => {
            if (document.visibilityState === 'visible') {
                setNow(Date.now())
                if (timer === null) timer = setInterval(() => setNow(Date.now()), tickMs)
            } else {
                stop()
            }
        }
        sync()
        document.addEventListener('visibilitychange', sync)
        return () => {
            stop()
            document.removeEventListener('visibilitychange', sync)
        }
    }, [tickMs])
    return now
}

'use client'

import { useEffect, useRef } from 'react'

/**
 * Re-runs `poll` on an interval for as long as `enabled` is true, pausing while
 * the tab is hidden.
 *
 * Reserved for states that are *expected to end on their own* — a cluster
 * waiting for its scanner's first upload, say. The condition that enables it is
 * the same condition the arriving data falsifies, so the interval stops itself.
 * Anything without that property should use `useRevalidateOnFocus` instead
 * rather than polling a backend that has nothing new to say.
 */
export function usePollWhile(
    enabled: boolean,
    poll: () => void | Promise<void>,
    intervalMs: number
) {
    const pollRef = useRef(poll)
    useEffect(() => {
        pollRef.current = poll
    })

    useEffect(() => {
        if (!enabled) return

        let timer: ReturnType<typeof setInterval> | null = null

        const stop = () => {
            if (timer !== null) {
                clearInterval(timer)
                timer = null
            }
        }
        const sync = () => {
            if (document.visibilityState === 'visible') {
                if (timer === null) timer = setInterval(() => { void pollRef.current() }, intervalMs)
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
    }, [enabled, intervalMs])
}

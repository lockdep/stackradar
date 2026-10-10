'use client'

import { useEffect, useState } from 'react'
import { formatTimeAgo } from '@/utils/formatters'

/**
 * A relative timestamp ("5m ago") that keeps itself fresh.
 *
 * Owns its own once-a-minute ticker, so components that show "updated X ago"
 * don't need a force-render interval of their own — only this leaf re-renders.
 */
export function RelativeTime({ date }: { date: Date }) {
    const [, setTick] = useState(0)

    useEffect(() => {
        const interval = setInterval(() => setTick(n => n + 1), 60_000)
        return () => clearInterval(interval)
    }, [])

    return <>{formatTimeAgo(date)}</>
}

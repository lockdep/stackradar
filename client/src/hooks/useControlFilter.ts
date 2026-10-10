'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CONTROL_FILTER_PARAM, isControlFilter, type ControlFilter } from '@/lib/image-control'

/**
 * "Yours / Third-party / All", held in the URL like the lists' other filters
 * (`useSeverityFilter`): a filtered list is a link people paste, and the Radar
 * Score split links here with `?control=`. The default — All — is absent from
 * the query string, and a hand-edited value degrades to it.
 *
 * Needs a Suspense boundary above it, like every `useSearchParams` reader.
 */
export function useControlFilter(): { control: ControlFilter; setControl: (next: ControlFilter) => void } {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const param = searchParams.get(CONTROL_FILTER_PARAM)
    const control: ControlFilter = isControlFilter(param) ? param : 'all'

    const setControl = useCallback(
        (next: ControlFilter) => {
            const params = new URLSearchParams(searchParams.toString())
            if (next === 'all') params.delete(CONTROL_FILTER_PARAM)
            else params.set(CONTROL_FILTER_PARAM, next)
            const query = params.toString()
            router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
        },
        [pathname, router, searchParams]
    )

    return { control, setControl }
}

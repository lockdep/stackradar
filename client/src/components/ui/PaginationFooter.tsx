'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './Button'

type Props = {
    total: number
    pageSize: number
    /**
     * The *displayed* data's own offset — never the pending query's, so the
     * footer never claims a page that is still loading.
     */
    shownOffset: number
    /** How many rows the displayed page actually holds. */
    shownCount: number
    /** Disables both buttons while a replacement page is in flight. */
    isStale: boolean
    /** Optional noun after the total ("advisories"). */
    unit?: string
    onOffsetChange: (offset: number) => void
}

/**
 * The offset-paging footer of a server-paged table: the shown range, and
 * Previous/Next stepping by page. Renders nothing while everything fits on
 * one page. Pair it with `usePagedResource`.
 */
export function PaginationFooter({
    total,
    pageSize,
    shownOffset,
    shownCount,
    isStale,
    unit,
    onOffsetChange,
}: Props) {
    if (total <= pageSize) return null

    const rangeStart = total === 0 ? 0 : shownOffset + 1
    const rangeEnd = shownOffset + shownCount

    return (
        /* Stacked on phones — the count above the buttons — so neither has
           to shrink into the other. */
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="text-xs text-ink-muted tabular-nums sm:text-sm">
                {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{' '}
                {total.toLocaleString()}
                {unit ? ` ${unit}` : ''}
            </p>
            <div className="flex items-center gap-1.5">
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={shownOffset === 0 || isStale}
                    onClick={() => onOffsetChange(Math.max(0, shownOffset - pageSize))}
                >
                    <ChevronLeft aria-hidden="true" className="size-3.5" />
                    Previous
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={rangeEnd >= total || isStale}
                    onClick={() => onOffsetChange(shownOffset + pageSize)}
                >
                    Next
                    <ChevronRight aria-hidden="true" className="size-3.5" />
                </Button>
            </div>
        </div>
    )
}

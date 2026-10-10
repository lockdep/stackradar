'use client'

import { CalendarDays } from 'lucide-react'
import {
    DAYS_OPTIONS,
    FilterBar,
    FilterBarEnd,
    FilterBarRefresh,
    FilterBarReset,
    FilterMenu,
    FindingsFilterMenu,
    ImagesFilterMenu,
} from '@/components/ui'
import { type ControlFilter } from '@/lib/image-control'
import { type TierLens } from '@/lib/tier-lens'

/** The page's three filters — one value each, carried by every block's request. */
export type DashboardFilters = {
    /** The history window, in days. */
    days: number
    /** Whose images. */
    control: ControlFilter
    /** Which findings: what the build added, or what the base image brought. */
    lens: TierLens
}

/**
 * The Dashboard's one row of filters, over everything it scopes.
 *
 * The page used to carry three controls in three places — whose images above
 * the first table, the findings lens inside the second, the window halfway
 * down — and each scoped only the blocks near it, which the reader had to
 * work out. They are one toolbar now (`ui/FilterBar`, which the findings
 * lists share), directly under the title and above the first block. No block
 * has a copy of any of them.
 *
 * Time on the left with the refresh — *when* — and what is counted on the
 * right — *which images, which findings*. Each button reads as its value, and
 * one that hides something is outlined in the accent colour with a Reset
 * beside it, so a narrowed Dashboard is never mistaken for the whole one.
 */
export function DashboardFilterBar({
    filters,
    defaults,
    maxDays,
    onChange,
    onRefresh,
    isRefreshing,
    canManageImages,
}: {
    filters: DashboardFilters
    /** What Reset returns to, and what "narrowed" is measured against. */
    defaults: DashboardFilters
    /** The plan's history window; longer ranges are not offered. */
    maxDays: number
    onChange: (next: Partial<DashboardFilters>) => void
    onRefresh: () => void
    isRefreshing: boolean
    /**
     * Whether the reader can open Organization settings → Image ownership,
     * where "organization" and "third-party" are decided per repository. The
     * filter is only as right as that list, so the way to it is in the menu.
     */
    canManageImages: boolean
}) {
    const dayOptions = DAYS_OPTIONS.filter(option => option.value <= maxDays)
    const changed =
        filters.days !== defaults.days || filters.control !== defaults.control || filters.lens !== defaults.lens

    return (
        <FilterBar label="Dashboard filters — apply to everything on this page">
            <FilterBarRefresh onRefresh={onRefresh} isRefreshing={isRefreshing} label="Refresh the dashboard" />
            <FilterMenu
                label="Date range"
                icon={<CalendarDays />}
                value={filters.days}
                options={dayOptions}
                onChange={days => onChange({ days })}
            />

            <p className="ml-1 hidden text-xs text-ink-muted md:block">Filters apply to the whole dashboard.</p>

            <FilterBarEnd>
                {changed && <FilterBarReset onReset={() => onChange(defaults)} />}
                <ImagesFilterMenu
                    value={filters.control}
                    onChange={control => onChange({ control })}
                    canManageImages={canManageImages}
                />
                <FindingsFilterMenu value={filters.lens} onChange={lens => onChange({ lens })} />
            </FilterBarEnd>
        </FilterBar>
    )
}

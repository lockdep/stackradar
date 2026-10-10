'use client'

import type { ReactNode } from 'react'
import { ListFilter, RefreshCw, Settings } from 'lucide-react'
import { Button } from './Button'
import { EntityIcon } from './EntityIcon'
import { FilterMenu, type FilterMenuOption } from './FilterMenu'
import { CONTROL_FILTER_HINT, type ControlFilter } from '@/lib/image-control'
import { TIER_LENS_HINT, type TierCounts, type TierLens } from '@/lib/tier-lens'

/**
 * A page's one row of filters, over everything it scopes: a full-width
 * toolbar directly under the title whose rule is the header's, and which
 * stays in view while the page scrolls — a filter that follows the reader
 * down the page is visibly the page's, not a block's.
 *
 * The convention inside it: *when* and the refresh on the left, *what is
 * counted* in a `FilterBarEnd` on the right. Each menu reads as its value, and
 * one that hides something is filled and lettered in the accent colour with a Reset
 * beside it, so a narrowed page is never mistaken for the whole one.
 */
export function FilterBar({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div
            role="toolbar"
            aria-label={label}
            className="-mx-4 mb-6 flex flex-wrap items-center gap-2 border-y border-edge bg-surface px-4 py-2 sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:z-30 lg:-mx-8 lg:px-8"
        >
            {children}
        </div>
    )
}

/** The right-hand group: Reset, then the menus that decide what is counted. */
export function FilterBarEnd({ children }: { children: ReactNode }) {
    return <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
}

export function FilterBarRefresh({
    onRefresh,
    isRefreshing,
    label,
}: {
    onRefresh: () => void
    isRefreshing: boolean
    /** The accessible name — say what is refreshed. */
    label: string
}) {
    return (
        <Button onClick={onRefresh} disabled={isRefreshing} aria-label={label} title="Refresh" className="w-8 pl-0 pr-0">
            <RefreshCw aria-hidden className={`size-4 text-ink-muted ${isRefreshing ? 'animate-spin' : ''}`} />
        </Button>
    )
}

export function FilterBarReset({ onReset }: { onReset: () => void }) {
    return (
        <Button variant="invisible" onClick={onReset}>
            Reset
        </Button>
    )
}

/* "All" first, unlike the lists' segmented controls: a menu opens on its
   widest option, and the two narrowings read as narrowings under it. The
   options name their noun — a closed button shows one of them on its own. */
const IMAGE_OPTIONS: readonly FilterMenuOption<ControlFilter>[] = [
    { value: 'all', label: 'All images', description: CONTROL_FILTER_HINT.all },
    { value: 'yours', label: 'Organization images', description: CONTROL_FILTER_HINT.yours },
    { value: 'third-party', label: 'Third-party images', description: CONTROL_FILTER_HINT['third-party'] },
]

const FINDING_OPTIONS: readonly FilterMenuOption<TierLens>[] = [
    { value: 'all', label: 'All findings', description: TIER_LENS_HINT.all },
    { value: 'application', label: 'Application findings', description: TIER_LENS_HINT.application },
    { value: 'base', label: 'Base image findings', description: TIER_LENS_HINT.base },
]

export type ScopeFilter = {
    /** The chosen value, or null for all of them. */
    value: string | null
    options: readonly { value: string; label: string }[]
    onChange: (value: string | null) => void
}

/* `FilterMenu` selects among values, and "all of them" is the absence of one:
   the empty string stands in for null, which no cluster id or namespace name
   can be. */
const ALL_OF_SCOPE = ''

/** Where — the bar's "Cluster" and "Namespace" menus: one of the options, or all of them. */
export function ScopeFilterMenu({
    label,
    allLabel,
    icon,
    scope,
}: {
    label: string
    /** The first option's text — "All clusters". */
    allLabel: string
    icon?: ReactNode
    scope: ScopeFilter
}) {
    return (
        <FilterMenu
            label={label}
            icon={icon}
            value={scope.value ?? ALL_OF_SCOPE}
            options={[{ value: ALL_OF_SCOPE, label: allLabel }, ...scope.options]}
            onChange={next => scope.onChange(next === ALL_OF_SCOPE ? null : next)}
            narrowed={scope.value !== null}
            align="end"
        />
    )
}

/** Whose images — the bar's "Images" menu. */
export function ImagesFilterMenu({
    value,
    onChange,
    canManageImages,
    counts,
}: {
    value: ControlFilter
    onChange: (next: ControlFilter) => void
    /** How many rows each choice would list. Omitted where the page cannot say without asking the server. */
    counts?: Record<ControlFilter, number> | undefined
    /**
     * Whether the reader can open Organization settings → Image ownership,
     * where "organization" and "third-party" are decided per repository. The
     * filter is only as right as that list, so the way to it is in the menu.
     */
    canManageImages: boolean
}) {
    const options = counts ? IMAGE_OPTIONS.map(option => ({ ...option, count: counts[option.value] })) : IMAGE_OPTIONS
    return (
        <FilterMenu
            label="Images"
            icon={<EntityIcon kind="image" className="size-4" />}
            value={value}
            options={options}
            onChange={onChange}
            narrowed={value !== 'all'}
            align="end"
            footerLink={
                canManageImages
                    ? { href: '/org-settings?tab=image-ownership', label: 'Manage image ownership', icon: <Settings /> }
                    : undefined
            }
        />
    )
}

/** Which findings — the bar's "Findings" menu, the lens as a menu. */
export function FindingsFilterMenu({
    value,
    onChange,
    counts,
}: {
    value: TierLens
    onChange: (next: TierLens) => void
    /** Per-bucket finding counts, so the folded bucket is never invisible. Omitted where the page has none. */
    counts?: TierCounts | undefined
}) {
    const options = counts ? FINDING_OPTIONS.map(option => ({ ...option, count: counts[option.value] })) : FINDING_OPTIONS
    return (
        <FilterMenu
            label="Findings"
            icon={<ListFilter />}
            value={value}
            options={options}
            onChange={onChange}
            narrowed={value !== 'all'}
            align="end"
        />
    )
}

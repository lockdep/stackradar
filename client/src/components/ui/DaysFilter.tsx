'use client'

import { ChevronDown } from 'lucide-react'

/* Labelled in words, not "7d": a closed select shows one option on its own,
   and "Last 7 days" reads as the window it is without the surrounding
   buttons a segmented control leaned on for context. */
export const DAYS_OPTIONS = [
    { label: 'Last 24 hours', value: 1 },
    { label: 'Last 3 days', value: 3 },
    { label: 'Last 7 days', value: 7 },
    { label: 'Last 14 days', value: 14 },
    { label: 'Last 30 days', value: 30 },
    { label: 'Last 90 days', value: 90 },
    { label: 'Last year', value: 365 },
    { label: 'Last 2 years', value: 730 },
]

interface DaysFilterProps {
    value: number
    onChange: (days: number) => void
    /**
     * The plan's history window (`getPlanHistoryDays`); options beyond it are
     * not rendered rather than rendered disabled — the server clamps to the
     * same window, so a wider option would fetch the same data it claims to
     * exceed. Defaults to 30 so a caller without plan context never
     * over-promises.
     */
    maxDays?: number
}

/**
 * The history window, as a single select rather than a row of eight
 * buttons. Same markup as the Feed's cluster scope select — a native
 * `<select>` dressed as a secondary button, with the chevron drawn by us
 * because `appearance-none` removes the browser's — so the two controls
 * read as one family where they sit side by side.
 */
export function DaysFilter({ value, onChange, maxDays = 30 }: DaysFilterProps) {
    return (
        <span className="relative inline-block">
            <select
                aria-label="Time range"
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="h-8 appearance-none rounded-md border border-edge bg-btn-secondary pr-8 pl-3 text-sm text-ink hover:bg-btn-secondary-hover cursor-pointer"
            >
                {DAYS_OPTIONS.filter(opt => opt.value <= maxDays).map(opt => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>
            <ChevronDown
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-muted"
            />
        </span>
    )
}

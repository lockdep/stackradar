'use client'

import { useRef, type KeyboardEvent } from 'react'
import {
    underlineNavItemClasses,
    underlineNavItemActiveClasses,
    UnderlineNavItemContent,
} from './underlineNav'
import {
    TIER_LENSES,
    TIER_LENS_HINT,
    TIER_LENS_LABEL,
    type TierCounts,
    type TierLens,
} from '@/lib/tier-lens'

interface UnderlineRadioGroupProps<T extends string> {
    options: readonly T[]
    value: T
    onChange: (value: T) => void
    label: Record<T, string>
    hint?: Partial<Record<T, string>>
    /** Primer's counter slot per option. Omitted until the numbers are known. */
    counts?: Partial<Record<T, number>> | undefined
    ariaLabel: string
    className?: string
}

/**
 * A short row of mutually exclusive views over one table, wearing `TabBar`'s
 * item styling (semibold label plus the coral underline, Primer's counter
 * slot) without its strip. It filters one table rather than swapping a
 * panel, so it is a radio group, not a tablist, and owns no `tabpanel`.
 */
export function UnderlineRadioGroup<T extends string>({
    options,
    value,
    onChange,
    label,
    hint,
    counts,
    ariaLabel,
    className = '',
}: UnderlineRadioGroupProps<T>) {
    const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({})

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        const offset =
            event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
            : 0
        if (offset === 0) return
        event.preventDefault()
        const next = options[(options.indexOf(value) + offset + options.length) % options.length]
        onChange(next)
        refs.current[next]?.focus()
    }

    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className={`flex flex-wrap items-center gap-x-2 border-b border-edge pt-0 ${className}`}
        >
            {options.map(option => {
                const selected = option === value
                const count = counts?.[option]
                return (
                    <button
                        key={option}
                        ref={el => { refs.current[option] = el }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        title={hint?.[option]}
                        onClick={() => onChange(option)}
                        onKeyDown={handleKeyDown}
                        className={`${underlineNavItemClasses} ${selected ? underlineNavItemActiveClasses : ''}`}
                    >
                        <UnderlineNavItemContent name={label[option]} labelClassName={selected ? 'font-semibold' : ''}>
                            {count !== undefined && (
                                <span className="rounded-full bg-neutral-subtle px-1.5 text-xs font-medium tabular-nums text-ink">
                                    {count.toLocaleString()}
                                </span>
                            )}
                        </UnderlineNavItemContent>
                    </button>
                )
            })}
        </div>
    )
}

interface TierLensControlProps {
    lens: TierLens
    onChange: (lens: TierLens) => void
    /** Per-bucket finding counts, unlensed. Omitted until the first response. */
    counts?: TierCounts | undefined
    className?: string
}

/**
 * "Application (12) · Base image (231) · All (243)" — which findings a table
 * shows first. Three segments, no label, the count in each so the folded
 * bucket is never invisible.
 */
export function TierLensControl({ lens, onChange, counts, className = '' }: TierLensControlProps) {
    return (
        <UnderlineRadioGroup
            options={TIER_LENSES}
            value={lens}
            onChange={onChange}
            label={TIER_LENS_LABEL}
            hint={TIER_LENS_HINT}
            counts={counts}
            ariaLabel="Which findings to show"
            className={className}
        />
    )
}

/**
 * The Application lens's empty state when the base bucket is not empty —
 * never a blank table. The count is a button onto the Base image segment.
 */
export function TierLensEmpty({
    lens,
    counts,
    onChange,
}: {
    lens: TierLens
    counts: TierCounts | undefined
    onChange: (lens: TierLens) => void
}) {
    if (!counts) return null
    const other: TierLens | null =
        lens === 'application' && counts.base > 0 ? 'base'
        : lens === 'base' && counts.application > 0 ? 'application'
        : null
    if (!other) return null
    const n = counts[other]
    return (
        <span>
            {lens === 'application'
                ? 'Nothing in your application packages. '
                : 'Nothing in the base image. '}
            <button
                type="button"
                onClick={() => onChange(other)}
                className="cursor-pointer text-accent hover:underline"
            >
                {n.toLocaleString()} {n === 1 ? 'finding is' : 'findings are'} in{' '}
                {other === 'base' ? 'the base image' : 'your application packages'} →
            </button>
        </span>
    )
}

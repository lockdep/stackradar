'use client'

import { useId, type ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'

/**
 * A "?" that explains on hover or keyboard focus, for a heading whose one-line
 * description cannot carry every rule. Same CSS-only mechanics as the badges in
 * `ClusterTable.tsx` (`group-hover` / `group-focus-within`, `role="tooltip"`
 * wired through `aria-describedby`), so it needs no portal and no state.
 *
 * Positioned below and left-aligned to the icon: the icon sits at the end of a
 * heading, so a right-anchored panel would run off narrow screens.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
    const tooltipId = useId()
    return (
        <span className="group/helptip relative inline-flex align-middle">
            <button
                type="button"
                aria-label={label}
                aria-describedby={tooltipId}
                className="inline-flex cursor-help rounded-full text-ink-faint transition-colors hover:text-ink-secondary focus-visible:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
            >
                <CircleHelp aria-hidden="true" className="size-4" />
            </button>
            <div
                id={tooltipId}
                role="tooltip"
                className="absolute left-0 top-full z-50 mt-1.5 hidden w-72 rounded-md bg-ink px-3 py-2 text-xs leading-relaxed text-surface shadow-floating group-hover/helptip:block group-focus-within/helptip:block"
            >
                {children}
            </div>
        </span>
    )
}

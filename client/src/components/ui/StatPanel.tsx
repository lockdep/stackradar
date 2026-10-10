'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { TrendDelta, type TrendDeltaDirection } from './TrendDelta'

export interface StatCell {
    key: string
    label: string
    value: number
    /** Change over the period. Omit to hide the delta entirely. */
    delta?: number
    deltaDirection?: TrendDeltaDirection
    /** Tailwind background class for the leading dot, e.g. `bg-sev-high-emphasis`. */
    dotClass?: string
    /** Rendered flush to the bottom edge of the cell. */
    sparkline?: ReactNode
    /** Makes the whole cell a link to the list behind the number. */
    href?: string
    /** Accessible name and tooltip for that link, e.g. "See all critical vulnerabilities". */
    hrefTitle?: string
}

/**
 * Cell dividers for a grid that is 2 columns on mobile and `cells.length` on
 * `sm+`. Borders live on the cells rather than on `divide-x`, which can't
 * express "left border only at this breakpoint".
 */
function cellBorders(i: number, count: number) {
    if (count <= 2) return i > 0 ? 'border-l border-edge' : ''
    const parts = ['border-edge']
    if (i % 2 === 1) parts.push('border-l')
    else if (i > 0) parts.push('sm:border-l')
    if (i >= 2) parts.push('border-t sm:border-t-0')
    return parts.join(' ')
}

export interface StatPanelProps {
    /** Section heading above the panel. Omit for a bare panel. */
    title?: string
    /** Rendered right-aligned on the heading row (e.g. a DaysFilter). */
    action?: ReactNode
    cells: StatCell[]
    /**
     * `panel` (default): one bordered box with hairline-divided cells.
     * `cards`: one bordered card per cell in a `gap-4` grid — the same
     * spacing and radius as the `MetricsChartCard` grids it sits alongside.
     */
    variant?: 'panel' | 'cards'
}

function CellContent({ cell, variant }: { cell: StatCell; variant: 'panel' | 'cards' }) {
    /* Card padding matches MetricsChartCard's `p-5`; panel cells stay tighter
       because the shared border already frames them. */
    const pad = variant === 'cards'
        ? { x: 'px-5', top: 'pt-5', bottom: 'pb-5' }
        : { x: 'px-4', top: 'pt-3.5', bottom: 'pb-3.5' }
    return (
        <>
            {/* `pb-2` is a gap before the sparkline, not the cell's bottom
                padding — without one it has to match the top padding itself,
                or a figure-only cell (workloads, components) reads as cropped. */}
            <div className={`${pad.x} ${pad.top} ${cell.sparkline ? 'pb-2' : pad.bottom}`}>
                <div className="flex min-w-0 items-center gap-1.5">
                    {cell.dotClass && (
                        <span className={`inline-block size-2 shrink-0 rounded-full ${cell.dotClass}`} />
                    )}
                    <p className="truncate text-xs font-medium text-ink-muted capitalize">{cell.label}</p>
                    {/* The linked cell's standing affordance — faint until the
                        hover fill already says "this is interactive". */}
                    {cell.href && (
                        <ArrowRight
                            aria-hidden="true"
                            className="ml-auto size-3 shrink-0 text-ink-faint group-hover/statcell:text-accent group-focus-visible/statcell:text-accent"
                        />
                    )}
                </div>
                <div className="mt-1.5 flex items-baseline gap-2">
                    <p className="text-2xl leading-none font-semibold text-ink tabular-nums">
                        {cell.value.toLocaleString()}
                    </p>
                    {cell.delta !== undefined && (
                        <TrendDelta delta={cell.delta} direction={cell.deltaDirection} />
                    )}
                </div>
            </div>
            {/* Inset, not bled to the cell edge: full-bleed sparklines in
                adjacent cells meet at the 1px divider, so a red critical fill
                runs straight into an orange high one and the two read as a
                single chart. The gutter is what separates them. */}
            {cell.sparkline && <div className={`mt-auto ${pad.x} ${pad.bottom}`}>{cell.sparkline}</div>}
        </>
    )
}

/**
 * One bordered panel of divided cells — the dashboard's unit of grouping.
 *
 * Deliberately *not* one card per number: a row of separately-bordered cards all
 * at the same elevation gives the eye nothing to rank, which is what the old
 * four-severity-card row did. Grouping related figures inside a single card and
 * separating them with hairlines is how Primer composes this.
 *
 * A cell with an `href` becomes a link to the list its number summarises —
 * the whole cell, not a nested "see all" control, so the target is the full
 * cell and the panel keeps a single visual grammar either way.
 *
 * `variant="cards"` trades the shared border for one card per cell, so the
 * row matches the `MetricsChartCard` grids (same `gap-4`, same `rounded-md`)
 * on surfaces that place them side by side.
 */
export function StatPanel({ title, action, cells, variant = 'panel' }: StatPanelProps) {
    if (cells.length === 0) return null

    const renderCell = (cell: StatCell, className: string) => (
        <div key={cell.key} className={className}>
            {cell.href ? (
                <Link
                    href={cell.href}
                    title={cell.hrefTitle}
                    aria-label={cell.hrefTitle}
                    className="group/statcell flex flex-1 flex-col hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover"
                >
                    <CellContent cell={cell} variant={variant} />
                </Link>
            ) : (
                <CellContent cell={cell} variant={variant} />
            )}
        </div>
    )

    return (
        <div>
            {(title || action) && (
                <div className="mb-3 flex items-center justify-between gap-4">
                    {title && <h2 className="text-sm font-semibold text-ink-secondary">{title}</h2>}
                    {action}
                </div>
            )}
            {variant === 'cards' ? (
                <div
                    className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
                        cells.length === 3 ? 'lg:grid-cols-3' : cells.length > 2 ? 'lg:grid-cols-4' : ''
                    }`}
                >
                    {cells.map(cell =>
                        renderCell(cell, 'flex flex-col overflow-hidden rounded-md border border-edge bg-surface-raised')
                    )}
                </div>
            ) : (
                <div className="overflow-hidden rounded-md border border-edge bg-surface-raised">
                    <div
                        className={`grid grid-cols-2 ${
                            cells.length === 3 ? 'sm:grid-cols-3' : cells.length > 2 ? 'sm:grid-cols-4' : ''
                        }`}
                    >
                        {cells.map((cell, i) =>
                            renderCell(cell, `flex flex-col ${cellBorders(i, cells.length)}`)
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

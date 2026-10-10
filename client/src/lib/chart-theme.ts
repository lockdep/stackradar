/**
 * The chart furniture every plot shares — axes, grid, cursor, active dot.
 *
 * Recharts styles these per-element and per-chart, which is how three charts ended
 * up restating the same six literals with nothing keeping them in step. Everything
 * here is Primer via the `--chart-*` tokens in `theme.css`; nothing in a chart file
 * should name a colour or a stroke width that isn't a data mark.
 *
 * The tooltip is the fourth piece and lives in `components/ui/ChartTooltip.tsx` —
 * it renders DOM, not SVG, so it belongs with the components.
 */

/** Axis tick labels. 11px is the one type size below the 12px `text-xs` floor we
 *  allow, and only here: a tick is a scale marker, read against the plot, not prose. */
export const CHART_TICK = { fontSize: 11, fill: 'var(--ink-muted)' } as const

/** Axis lines and tick lines both. They are the same rule at the same weight, and
 *  Recharts wants them as two props. */
export const CHART_AXIS_LINE = { stroke: 'var(--chart-axis)' } as const

export const CHART_GRID = { stroke: 'var(--chart-grid)', strokeWidth: 1 } as const

/** Unset, Recharts paints its own `#ccc` cursor — 10.78:1 on the dark card, brighter
 *  than the data it points at. A cursor is a transient axis, so it wears the axis token. */
export const CHART_CURSOR = { stroke: 'var(--chart-axis)', strokeWidth: 1 } as const

/** The hovered point on `color`'s series, ringed in the card surface so it reads as
 *  lifted off the line rather than as a fatter part of it. */
export function chartActiveDot(color: string) {
    return { r: 4, strokeWidth: 2, stroke: 'var(--surface-raised)', fill: color } as const
}

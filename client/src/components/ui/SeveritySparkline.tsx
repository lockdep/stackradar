'use client'

import { ResponsiveContainer, AreaChart, Area, XAxis, Tooltip } from 'recharts'
import { buildTimeAxis } from '@/lib/chart-time'
import { chartTooltipProps } from './ChartTooltip'
import type { MetricsSnapshot } from './MetricsChartCard'

export type SeverityKey = 'critical' | 'high' | 'medium' | 'low'

export const severityDotClass: Record<SeverityKey, string> = {
    critical: 'bg-sev-critical-emphasis',
    high: 'bg-sev-high-emphasis',
    medium: 'bg-sev-medium-emphasis',
    low: 'bg-sev-low-emphasis',
}

/* Tinted to match the leading dot. These used to all be `--chart-line` (blue),
   which left four visually identical sparklines under four differently-coloured
   labels — the one place on the dashboard where colour carries real meaning.

   Now via `--chart-sev-*` rather than `--sev-*` directly: these are chart marks
   bound by a 3:1 floor on the card as well as severity colours, and the token name
   is what makes that visible to whoever changes them next. Every one clears the
   floor (3.77–6.86:1 across both themes).

   They are safe *here* precisely because the four marks never touch — one
   sparkline per cell, each with its own text label and dot. critical↔high is
   ΔE 0.9/2.3 under deuteranopia, so a stacked severity chart is not an option;
   see the warning in theme.css. */
const severityLineColor: Record<SeverityKey, string> = {
    critical: 'var(--chart-sev-critical)',
    high: 'var(--chart-sev-high)',
    medium: 'var(--chart-sev-medium)',
    low: 'var(--chart-sev-low)',
}

const severityFillColor: Record<SeverityKey, string> = {
    critical: 'var(--chart-sev-critical-fill)',
    high: 'var(--chart-sev-high-fill)',
    medium: 'var(--chart-sev-medium-fill)',
    low: 'var(--chart-sev-low-fill)',
}

const severityDataKey: Record<SeverityKey, keyof MetricsSnapshot> = {
    critical: 'criticalVulnerabilities',
    high: 'highVulnerabilities',
    medium: 'mediumVulnerabilities',
    low: 'lowVulnerabilities',
}

function formatDay(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function SeveritySparkline({ data, severity, height = 52 }: { data: MetricsSnapshot[], severity: SeverityKey, height?: number }) {
    const dataKey = severityDataKey[severity]
    const color = severityLineColor[severity]
    const fill = severityFillColor[severity]
    const label = severity.charAt(0).toUpperCase() + severity.slice(1)

    // A sparkline needs two points to be a line. Below that, hold the cell's
    // height with a placeholder rather than returning null — a StatPanel cell
    // that silently loses its chart makes the row look broken.
    if (data.length < 2) {
        return (
            <div
                className="flex items-center justify-center text-xs text-ink-muted"
                style={{ height }}
            >
                Not enough history yet
            </div>
        )
    }

    // Same time scale as `MetricsChartCard`, even though this axis is hidden: the
    // spacing is the point. On a category axis a missed hourly capture reads as a
    // normal step, so a sparkline would disagree with the chart above it about the
    // shape of the same gap.
    const rows = data.map(s => ({ ...s, __t: Date.parse(s.capturedAt) }))
    const firstMs = rows[0]!.__t
    const lastMs = rows[rows.length - 1]!.__t

    const first = data.at(0)![dataKey] as number
    const latest = data.at(-1)![dataKey] as number
    const chartLabel =
        `${label} vulnerabilities: ${first.toLocaleString()} on ${formatDay(data.at(0)!.capturedAt)} ` +
        `${latest === first ? 'unchanged at' : latest > first ? 'rising to' : 'falling to'} ` +
        `${latest.toLocaleString()} on ${formatDay(data.at(-1)!.capturedAt)}`

    // Granularity borrowed from the same helper the big chart uses, so a 1-day window
    // reads "16:00 … 15:00" here too instead of the same date twice.
    const { format } = buildTimeAxis(firstMs, lastMs)

    return (
        <div>
        <div role="img" aria-label={chartLabel}>
        <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
                <XAxis dataKey="__t" type="number" scale="time" domain={[firstMs, lastMs]} hide />
                {/* Same tooltip as the trend cards. The two chart-specific props stay:
                    a 52px plot has no room to host the box, so it escapes upward. */}
                <Tooltip
                    {...chartTooltipProps}
                    allowEscapeViewBox={{ x: false, y: true }}
                    position={{ y: -60 }}
                />
                {/* Flat wash rather than a vertical fade — the gradient was a
                    Tremor signature, not Primer's area spec.

                    `strokeWidth` stays 1.5 against Primer's 2px mark rule, as a
                    recorded exception: Primer's chart docs state they do not
                    support sparklines, so there is no sparkline spec to conform
                    to, and a 2px stroke in a 36px cell reads as a bar rather than
                    a line. Stroke weight is a legibility parameter tuned to plot
                    height, not a contrast one — the rules that *do* bind here are
                    the 3:1 mark floor and colour-not-alone, and both are met. */}
                <Area
                    type="monotone"
                    dataKey={dataKey}
                    // The tooltip's row label — "Critical", not `criticalVulnerabilities`.
                    // It used to come from a `formatter` returning the name alongside the
                    // value, which the shared tooltip has no reason to know about.
                    name={label}
                    stroke={color}
                    strokeWidth={1.5}
                    fill={fill}
                    fillOpacity={1}
                    dot={false}
                    isAnimationActive={false}
                />
            </AreaChart>
        </ResponsiveContainer>
        </div>
        {/* The range, as plain HTML rather than a second Recharts axis.

            The plot spans the full container width here — no Y axis, zero left/right
            margin — so `justify-between` puts these at exactly the first and last
            datapoint, which is the same edge-anchored result `TimeTick` has to work
            for on the big chart. An <XAxis> would cost a tick-thinning pass and an
            SVG height negotiation to land in the same place.

            `aria-hidden` because `chartLabel` above already states both dates in a
            sentence; without it a screen reader reads the range twice per cell, and
            four times across the panel.

            11px matches `TimeTick`'s `fontSize` on the trend cards — same axis
            labels in the same panel, so they should not be two sizes. */}
        <div aria-hidden="true" className="mt-1 flex items-center justify-between gap-2 text-[11px] leading-none text-ink-muted tabular-nums">
            {/* `whitespace-nowrap` because "25 Jun" contains a space and these cells get
                narrow — a label breaking across two lines would push the cell taller
                than its three siblings and break the row. */}
            <span className="whitespace-nowrap">{format(firstMs)}</span>
            <span className="whitespace-nowrap">{format(lastMs)}</span>
        </div>
        </div>
    )
}

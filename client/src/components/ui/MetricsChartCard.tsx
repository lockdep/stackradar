'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ArrowRight, BarChart3 } from 'lucide-react'
import { buildTimeAxis } from '@/lib/chart-time'
import { CHART_AXIS_LINE, CHART_GRID, CHART_TICK, chartActiveDot } from '@/lib/chart-theme'
import { chartTooltipProps } from './ChartTooltip'
import { TrendDelta, type TrendDeltaDirection } from './TrendDelta'
import {
    ResponsiveContainer,
    ComposedChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Text,
} from 'recharts'

export interface MetricsSnapshot {
    id: string
    capturedAt: string
    totalVulnerabilities: number
    totalWorkloads: number
    totalComponents: number
    criticalVulnerabilities: number
    highVulnerabilities: number
    mediumVulnerabilities: number
    lowVulnerabilities: number
    /** Total risk (ADR 0007 sum). Captured on cluster and org snapshots. */
    riskScore?: number
}

/** The one overlay we support. A derived series, so it is a name rather than a `dataKey`. */
export type MetricsOverlay = 'criticalAndHigh'

/** Namespaced so they can't collide with a real `MetricsSnapshot` key. */
const OVERLAY_KEY = '__criticalAndHigh'
const OVERLAY_LABEL = 'Critical + High'

/**
 * `capturedAt` as epoch ms, so the X axis can be a real time scale.
 *
 * A category axis keyed on the ISO string spaces points by array *index*, which is
 * only the same as spacing by time while hourly capture is unbroken — a missed
 * worker run rendered as a normal one-hour step instead of the gap it was.
 */
const TIME_KEY = '__t'

export interface MetricsChartCardProps {
    title: string
    description: string
    dataKey: keyof Pick<MetricsSnapshot, 'totalVulnerabilities' | 'totalWorkloads' | 'totalComponents' | 'riskScore'>
    data: MetricsSnapshot[]
    deltaDirection?: TrendDeltaDirection
    /** Plot height in px. The dashboard's hero chart runs taller than the default. */
    chartHeight?: number
    /**
     * Plot a second, emphasised series over the primary one.
     *
     * `criticalAndHigh` exists because a total vulnerability count is a poor risk
     * signal on its own: it is dominated by low and medium findings, so dropping
     * 500 lows while gaining 10 criticals reads as an improvement. The primary
     * series stays in the de-emphasis gray and carries volume as context, while
     * critical+high rides on top in the severity red and carries the point — the
     * "emphasis" form, one axis, same unit. Both are areas: the overlay's band is
     * the urgent share of the volume the primary series draws.
     */
    overlay?: MetricsOverlay
    /** Makes the whole card a link to the surface behind the number — same grammar as `StatPanel`'s linked cells. */
    href?: string
    /** Accessible name and tooltip for that link, e.g. "See all packages". */
    hrefTitle?: string
}

/**
 * Y ticks in compact form — `10K`, not `10000`.
 *
 * The gutter is sized to the widest tick (`width="auto"` below), so on a card this
 * narrow a five-digit label spends real plot width on precision nobody reads off an
 * axis anyway: the ticks are the scale, while the headline above the plot and the
 * tooltip inside it both carry the exact figure. Locale-aware, so the abbreviation
 * follows the same locale as every other number on the card rather than hardcoding
 * an English `k`.
 *
 * Nothing under 1,000 is abbreviated, and no two ticks can collapse to the same label:
 * Recharts' Y domain starts at 0, so across its five ticks the step is a fifth of the
 * max, and compact notation keeps two significant digits up to that spacing.
 */
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact' })
function formatCount(value: number) {
    return Math.abs(value) < 1000 ? value.toLocaleString() : compactFormat.format(value)
}

function formatDate(iso: string) {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * An X tick whose label is anchored *inside* the plot at the two ends.
 *
 * There are only ever two ticks — first sample and last — and Recharts centres every
 * tick label on its position, which at the ends reads badly in both directions: the
 * first hangs half its width left into the Y-axis gutter, the last hangs half its
 * width past the final datapoint, so the axis ends up wider than the data it
 * describes. Instead the first label starts at the plot's left edge (`textAnchor:
 * start`, i.e. immediately after the Y axis) and the last ends at the right edge
 * (`textAnchor: end`), which is how Stripe's charts do it.
 *
 * Recharts clones this element with its own `textAnchor`, `fill` and `verticalAnchor`
 * among the tick props, and `cloneElement` lets those win over an element's own. So
 * they are deliberately *not* destructured or forwarded here — the component sets all
 * three itself, which is the only way the edge anchoring survives.
 */
function TimeTick({
    x = 0,
    y = 0,
    payload,
    firstMs,
    lastMs,
    format,
}: {
    x?: number
    y?: number
    payload?: { value?: number; coordinate?: number }
    firstMs?: number
    lastMs?: number
    format?: (ms: number) => string
}) {
    const value = payload?.value
    if (value == null || !format) return null
    // A single snapshot is its own first *and* last tick. Edge-anchoring it would
    // shove the only label to one side of a plot it sits in the middle of.
    const isSinglePoint = firstMs === lastMs
    const textAnchor = isSinglePoint ? 'middle' : value === firstMs ? 'start' : 'end'

    // `x` is the tick's `tickCoord`, not its true position, and at the ends those
    // differ. `getTicksStart` nudges each end inward by half a label width so that a
    // *centred* label stays in bounds — the last tick's `tickCoord` is
    // `coordinate - width/2`, the first's is `coordinate + width/2`. Anchoring the end
    // of an already-shifted point moved the last label another half-width left of
    // where the plot actually ends, which is the bug this replaced.
    //
    // Nothing can overflow when read from `coordinate`: an end-anchored label at the
    // right edge spans [end - width, end], a start-anchored one [start, start + width].
    const tickX = payload?.coordinate ?? x

    return (
        <Text x={tickX} y={y} textAnchor={textAnchor} verticalAnchor="start" fontSize={11} fill="var(--ink-muted)">
            {format(value)}
        </Text>
    )
}

/** "5 on Jul 3 rising to 12 on Jul 25" — the movement of one series, in words. */
function describeSeries(label: string, first: number, last: number, firstAt: string, lastAt: string) {
    const verb = last === first ? 'unchanged at' : last > first ? 'rising to' : 'falling to'
    return `${label}: ${first.toLocaleString()} on ${formatDate(firstAt)} ${verb} ${last.toLocaleString()} on ${formatDate(lastAt)}`
}

export function MetricsChartCard({ title, description, dataKey, data, deltaDirection = 'neutral', chartHeight = 140, overlay, href, hrefTitle }: MetricsChartCardProps) {
    const latest = data.at(-1)?.[dataKey] ?? 0
    const first = data.at(0)?.[dataKey] ?? 0
    const delta = latest - first
    const isEmpty = data.length === 0

    // Both extra keys are derived, not stored, so they are computed here rather than
    // widening `MetricsSnapshot` with fields the API never sends.
    const rows = useMemo(
        () => data.map(s => ({
            ...s,
            [TIME_KEY]: Date.parse(s.capturedAt),
            ...(overlay ? { [OVERLAY_KEY]: s.criticalVulnerabilities + s.highVulnerabilities } : {}),
        })),
        [data, overlay],
    )

    const firstMs = data.length ? Date.parse(data[0]!.capturedAt) : 0
    const lastMs = data.length ? Date.parse(data.at(-1)!.capturedAt) : 0
    const timeAxis = useMemo(() => buildTimeAxis(firstMs, lastMs), [firstMs, lastMs])

    // A zero-width domain is what one snapshot produces, and a time scale maps every
    // value in it to a single edge. Pad it by an hour either side so the lone point
    // lands mid-plot, the way it did on the old category axis.
    const HOUR = 60 * 60 * 1000
    const xDomain: [number, number] = firstMs === lastMs ? [firstMs - HOUR, lastMs + HOUR] : [firstMs, lastMs]

    const overlayFirst = (data.at(0)?.criticalVulnerabilities ?? 0) + (data.at(0)?.highVulnerabilities ?? 0)
    const overlayLatest = (data.at(-1)?.criticalVulnerabilities ?? 0) + (data.at(-1)?.highVulnerabilities ?? 0)

    // Every primary series is gray, overlay or not: on this dashboard colour means
    // severity and nothing else, so the only hue in a plot is the critical+high
    // overlay. Workloads and components are volume — a blue mark on those cards
    // (the old no-overlay branch, `--chart-series-1`) spent a second hue on a
    // series that carries no risk signal, and put three different colours in one
    // row of trend cards. It lands on the same gray as the Low sparkline, which
    // shares this value via `--sev-low`.
    const primaryColor = 'var(--chart-series-muted)'
    const primaryFill = 'var(--chart-series-muted-fill)'

    // The SVG carries no text a screen reader can use, so summarise the series
    // as its accessible name: what is plotted, over what span, from where to where.
    const firstAt = data.at(0)?.capturedAt
    const latestAt = data.at(-1)?.capturedAt
    const chartLabel = isEmpty
        ? `${title}: no data yet`
        : data.length === 1
            ? `${title}: ${latest.toLocaleString()} on ${formatDate(latestAt!)}`
            : [
                  describeSeries(title, first, latest, firstAt!, latestAt!),
                  overlay && describeSeries(OVERLAY_LABEL, overlayFirst, overlayLatest, firstAt!, latestAt!),
              ].filter(Boolean).join('. ')

    // A legend is mandatory at two or more series — colour must never be the only
    // identity channel. It carries each series' current value too, so the endpoint
    // is readable without hovering.
    const legend = overlay
        ? [
              { label: title, color: primaryColor, value: latest },
              { label: OVERLAY_LABEL, color: 'var(--chart-sev-critical)', value: overlayLatest },
          ]
        : []

    const body = (
        <>
            <div>
                <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <p className="text-xs font-medium text-ink-muted truncate">{title}</p>
                        {/* The linked card's standing affordance — faint until the
                            hover fill already says "this is interactive". */}
                        {href && (
                            <ArrowRight
                                aria-hidden="true"
                                className="size-3 shrink-0 text-ink-faint group-hover/metricscard:text-accent group-focus-visible/metricscard:text-accent"
                            />
                        )}
                    </span>
                    {!isEmpty && data.length > 1 && <TrendDelta delta={delta} direction={deltaDirection} />}
                </div>
                <p className="mt-1.5 text-3xl font-semibold text-ink leading-none">
                    {isEmpty ? '—' : latest.toLocaleString()}
                </p>
                <p className="mt-1.5 text-xs text-ink-muted">{description}</p>
            </div>
            {isEmpty ? (
                <div className="mt-auto flex flex-col items-center justify-center gap-2 text-ink-muted" style={{ height: chartHeight }}>
                    <BarChart3 className="size-8" />
                    <p className="text-sm">No data yet — snapshots are captured hourly.</p>
                </div>
            ) : (
                <div className="mt-auto">
                    <div role="img" aria-label={chartLabel}>
                        <ResponsiveContainer width="100%" height={chartHeight}>
                            <ComposedChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                                <CartesianGrid vertical={false} {...CHART_GRID} />
                                {/* A time scale, not a category axis, showing exactly two labels:
                                    the first and last sample, anchored to the plot edges. Before
                                    this the axis rendered up to 720 index-spaced category ticks
                                    all formatted `month day`, which at `days=1` meant the same
                                    date 24 times. Granularity follows the window — see
                                    `buildTimeAxis`. */}
                                <XAxis
                                    dataKey={TIME_KEY}
                                    type="number"
                                    scale="time"
                                    domain={xDomain}
                                    ticks={timeAxis.ticks}
                                    // Looks redundant next to `tick` below — it is not. A custom
                                    // tick *element* never receives the formatted string (Recharts
                                    // passes `value` only to its own renderer), so `TimeTick`
                                    // formats `payload.value` itself. But Recharts still measures
                                    // `tickFormatter`'s output to decide whether both labels fit.
                                    // Drop it and it measures a 13-digit epoch number instead, and
                                    // decides they don't.
                                    tickFormatter={timeAxis.format}
                                    tick={<TimeTick firstMs={firstMs} lastMs={lastMs} format={timeAxis.format} />}
                                    tickLine={CHART_AXIS_LINE}
                                    axisLine={CHART_AXIS_LINE}
                                    // With only two ticks this is the rule that keeps *both* —
                                    // `preserveStartEnd` protects the head and the tail
                                    // specifically. `minTickGap` is then just the clearance
                                    // between them before the narrower card gives up on one.
                                    interval="preserveStartEnd"
                                    minTickGap={16}
                                />
                                {/* `width="auto"` sizes the gutter to the widest tick. It replaces a
                                    `margin.left: -24` that was reclaiming the gutter by hand and
                                    would now clip the restored axis line. */}
                                <YAxis
                                    tick={CHART_TICK}
                                    tickLine={CHART_AXIS_LINE}
                                    axisLine={CHART_AXIS_LINE}
                                    allowDecimals={false}
                                    tickFormatter={formatCount}
                                    width="auto"
                                />
                                {/* Shared with every other chart — surface, padding, row shape
                                    and the date-and-time label all live in `ChartTooltip`. Series
                                    names come off the `name` props below. */}
                                <Tooltip {...chartTooltipProps} />
                                {/* Flat wash + 2px outline, per Primer's area spec. The outline is
                                    load-bearing: the fill is ~1.2:1 on the card and does not clear
                                    3:1 on its own. `fillOpacity={1}` because Recharts defaults it to
                                    0.6 and the alpha belongs to the token. */}
                                <Area
                                    type="monotone"
                                    dataKey={dataKey}
                                    name={title}
                                    stroke={primaryColor}
                                    strokeWidth={2}
                                    fill={primaryFill}
                                    fillOpacity={1}
                                    dot={false}
                                    activeDot={chartActiveDot(primaryColor)}
                                    isAnimationActive={false}
                                />
                                {/* Also an area, so the band it encloses reads as the share of the
                                    total that is actually urgent rather than as a bare threshold
                                    line. Same 15% wash as the primary series, in the severity red;
                                    it paints after the gray, so the two washes blend below the
                                    critical+high line and the gray shows through alone above it. */}
                                {overlay && (
                                    <Area
                                        type="monotone"
                                        dataKey={OVERLAY_KEY}
                                        name={OVERLAY_LABEL}
                                        stroke="var(--chart-sev-critical)"
                                        strokeWidth={2}
                                        fill="var(--chart-sev-critical-fill)"
                                        fillOpacity={1}
                                        dot={false}
                                        activeDot={chartActiveDot('var(--chart-sev-critical)')}
                                        isAnimationActive={false}
                                    />
                                )}
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>
                    {/* A first snapshot is a normal state, not a broken chart. It
                        plots as a single mid-plot point (see `xDomain` above) and
                        says why there is no line yet — the alternative was hiding
                        the card until the second hourly capture, which is how a
                        user's first session came to have no chart in it at all. */}
                    {data.length === 1 && (
                        <p className="mt-2 text-xs text-ink-muted">Collecting — the line fills in hourly.</p>
                    )}
                    {legend.length > 0 && (
                        <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                            {legend.map(s => (
                                <li key={s.label} className="flex items-center gap-1.5 text-xs text-ink-muted">
                                    {/* A line key, not a filled box: at legend density a block of
                                        series colour is data-weight ink doing a label's job. */}
                                    <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                                    <span className="truncate">{s.label}</span>
                                    <span className="text-ink tabular-nums">{s.value.toLocaleString()}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </>
    )

    const cardClass = 'h-full bg-surface-raised rounded-md border border-edge p-5 flex flex-col gap-4'
    return href ? (
        <Link
            href={href}
            title={hrefTitle}
            aria-label={hrefTitle}
            className={`group/metricscard ${cardClass} hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover`}
        >
            {body}
        </Link>
    ) : (
        <div className={cardClass}>{body}</div>
    )
}

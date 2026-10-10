/**
 * Time-axis labels for the metrics charts.
 *
 * The axis shows exactly two labels — the **first and last sample** — anchored to the
 * ends of the plot. No interior markers: at these card sizes a row of dates competes
 * with the data for attention, and the tooltip already answers "what was the value
 * here?" far better than a tick can.
 *
 * The only real decision left is *granularity*, and it has to follow the window.
 * Metrics snapshots are captured hourly (`METRICS_CRON`, default `0 * * * *`) and the
 * API downsamples nothing, so a 30-day request is ~720 points and a 1-day request is
 * ~24. A fixed `month day` format — which is what the charts used to have — renders
 * the same date at both ends of a 1-day window and says nothing at all.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const formatTime = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const formatMonthYear = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })

/**
 * Under a day and a half the two ends share a date, so the time is the only thing
 * that distinguishes them; past ~200 days the year starts to matter. The threshold is
 * 36 hours rather than 48 so that a span crossing two midnights never reduces to two
 * bare times, which would be genuinely ambiguous.
 */
function pickFormat(span: number): (ms: number) => string {
    if (span <= 36 * HOUR) return formatTime
    if (span <= 200 * DAY) return formatDate
    return formatMonthYear
}

interface ChartTimeAxis {
    /** Millisecond tick positions — the first and last sample, or one tick if they coincide. */
    ticks: number[]
    /** Label for a tick. Also the right granularity for a standalone range caption. */
    format: (ms: number) => string
}

export function buildTimeAxis(firstMs: number, lastMs: number): ChartTimeAxis {
    const format = pickFormat(Math.max(lastMs - firstMs, 0))
    return { ticks: firstMs === lastMs ? [lastMs] : [firstMs, lastMs], format }
}

/**
 * The tooltip's axis label. Always the full date *and* time, whatever granularity the
 * axis ticks settled on — the ticks are a scale, the tooltip is the reading.
 *
 * Takes `unknown` because it is fed straight from a Recharts label, which is typed as
 * `string | number` and is the raw `__t` epoch in practice.
 */
export function formatTimestamp(value: unknown) {
    return new Date(value as number | string).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

import { notFound } from 'next/navigation'
import { MetricsChartCard, SeverityCards, StatPanel, ThemeToggle, type MetricsSnapshot } from '@/components/ui'

/**
 * Visual harness for the chart layer — `/dev/charts`.
 *
 * `client/docs/primer-audit/T7-charts.md` step 4 asks for a screenshot review
 * rather than a grep, because the mark spec changes how the charts *look*. The
 * real dashboard sits behind OAuth and a populated org, so this route renders the
 * same components against the same `theme.css` with fabricated snapshots — every
 * state that has ever been a bug, on one page, in both themes.
 *
 * Delete it freely; nothing imports it. It 404s outside development so it can
 * never be reachable in a deployed environment.
 */

const HOUR = 60 * 60 * 1000

/**
 * Hourly snapshots, because that is what production produces — `METRICS_CRON`
 * defaults to `0 * * * *` and the API downsamples nothing, so a 30-day request is
 * ~720 points and a 1-day request is ~24. Generating one point per *day* here would
 * have hidden the whole X-axis problem.
 *
 * Shaped to demonstrate why the hero chart needed the overlay: low findings fall by
 * ~400 over the window while criticals more than double. The total therefore
 * *improves* while real risk gets worse — the exact reading error a single total
 * line cannot show.
 *
 * `gapAt` optionally drops a run of samples so the time scale can be checked
 * against a real capture outage: on the old category axis a 30-hour gap rendered as
 * a single one-hour step.
 */
function makeSnapshots(days: number, gapAt?: { afterHours: number; lengthHours: number }): MetricsSnapshot[] {
    const points = days * 24
    const start = Date.now() - (points - 1) * HOUR
    const out: MetricsSnapshot[] = []
    for (let i = 0; i < points; i++) {
        if (gapAt && i > gapAt.afterHours && i <= gapAt.afterHours + gapAt.lengthHours) continue
        const t = i / (points - 1)
        // A slow drift plus a diurnal wobble, so the line has texture at 720 points
        // instead of reading as a straight ramp.
        const wobble = Math.sin((i / 24) * Math.PI * 2)
        const critical = Math.max(0, Math.round(6 + 12 * t + wobble))
        const high = Math.max(0, Math.round(74 + 28 * t + 4 * wobble))
        const medium = Math.max(0, Math.round(690 - 60 * t + 14 * wobble))
        const low = Math.max(0, Math.round(1640 - 420 * t + 30 * wobble))
        out.push({
            id: `snap-${i}`,
            capturedAt: new Date(start + i * HOUR).toISOString(),
            totalVulnerabilities: critical + high + medium + low,
            totalWorkloads: Math.round(112 + 16 * t),
            totalComponents: Math.round(13800 + 1100 * t),
            criticalVulnerabilities: critical,
            highVulnerabilities: high,
            mediumVulnerabilities: medium,
            lowVulnerabilities: low,
        })
    }
    return out
}

/** The windows `DaysFilter` actually offers. */
const WINDOWS = [1, 3, 7, 14, 30] as const

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
    return (
        <section className="space-y-3">
            <div>
                <h2 className="text-sm font-semibold text-ink">{title}</h2>
                <p className="text-xs text-ink-muted">{note}</p>
            </div>
            {children}
        </section>
    )
}

export default function ChartPreviewPage() {
    if (process.env.NODE_ENV === 'production') notFound()

    const snapshots = makeSnapshots(30)
    const first = snapshots[0]!
    const last = snapshots.at(-1)!

    return (
        <main className="min-h-full bg-surface p-8">
            <div className="mx-auto max-w-6xl space-y-10">
                <header className="flex items-end justify-between gap-4 border-b border-edge pb-4">
                    <div>
                        <h1 className="text-2xl font-bold text-ink">Chart layer preview</h1>
                        <p className="mt-1 text-sm text-ink-muted">
                            T7 verification harness. Toggle the theme and check both.
                        </p>
                    </div>
                    <ThemeToggle showLabels />
                </header>

                <div className="rounded-md border border-edge bg-surface-raised p-4 text-xs text-ink-muted">
                    <p className="font-semibold text-ink">What this data is doing</p>
                    <p className="mt-1">
                        Over the window, low findings fall {first.lowVulnerabilities - last.lowVulnerabilities} and
                        criticals rise {first.criticalVulnerabilities}→{last.criticalVulnerabilities}. The total moves{' '}
                        {first.totalVulnerabilities.toLocaleString()}→{last.totalVulnerabilities.toLocaleString()} —
                        i.e. <span className="text-ink">down</span>, while risk went{' '}
                        <span className="text-ink">up</span>. The red overlay is what makes that visible.
                    </p>
                </div>

                <Section
                    title="Hero chart — emphasis overlay"
                    note="Neutral area = total (context). Red 2px line = critical + high (the point). Legend carries both current values."
                >
                    <MetricsChartCard
                        title="Total Vulnerabilities"
                        description="Distinct vulnerabilities across all current SBOMs"
                        dataKey="totalVulnerabilities"
                        data={snapshots}
                        deltaDirection="up-bad"
                        chartHeight={220}
                        overlay="criticalAndHigh"
                    />
                </Section>

                <Section
                    title="Severity panel — four sparklines"
                    note="The four severity marks never touch here, which is the only reason they are legal: critical↔high is ΔE 0.9/2.3 under deuteranopia. Each cell now carries its own first/last date under the plot, flush to the cell edges."
                >
                    <SeverityCards snapshots={snapshots} />
                </Section>

                <Section
                    title="Severity panel at a 1-day window"
                    note="The range labels take their granularity from the same helper as the big chart, so 24 hours reads as times rather than the same date twice."
                >
                    <SeverityCards snapshots={makeSnapshots(1)} />
                </Section>

                <Section
                    title="Cluster overview grid"
                    note="The 140px default height, incl. restored axis lines and the auto-width Y gutter that replaced margin.left: -24."
                >
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="lg:col-span-2">
                            <MetricsChartCard
                                title="Vulnerabilities"
                                description="Distinct vulnerabilities across all current SBOMs"
                                dataKey="totalVulnerabilities"
                                data={snapshots}
                                deltaDirection="up-bad"
                                overlay="criticalAndHigh"
                            />
                        </div>
                        <MetricsChartCard
                            title="Running containers"
                            description="Containers running in the cluster"
                            dataKey="totalWorkloads"
                            data={snapshots}
                        />
                        <MetricsChartCard
                            title="Components"
                            description="Unique components from all current SBOMs"
                            dataKey="totalComponents"
                            data={snapshots}
                        />
                    </div>
                </Section>

                <Section
                    title="Single series, no overlay"
                    note="Same neutral mark as the context series in the hero chart — inside a plot, colour means severity, so a volume series gets no hue of its own. The data blue below is defined but unused."
                >
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <MetricsChartCard
                            title="Components"
                            description="Unique components from all current SBOMs"
                            dataKey="totalComponents"
                            data={snapshots}
                            chartHeight={180}
                        />
                        <div className="rounded-md border border-edge bg-surface-raised p-5">
                            <p className="text-xs font-medium text-ink-muted">Chart layer swatches</p>
                            <p className="mt-2 text-sm text-ink">
                                Only the first two are painted. The other three are here so the reserved
                                data blue stays visibly distinct from{' '}
                                <a href="#" className="text-accent hover:underline">accent blue</a> —
                                before T7-2 the chart mark and every link were the same colour.
                            </p>
                            <div className="mt-4 space-y-2">
                                {[
                                    ['--chart-series-muted', 'every plotted series'],
                                    ['--chart-sev-critical', 'critical + high overlay'],
                                    ['--chart-series-1', 'data blue — reserved, unused'],
                                    ['--accent', 'link / focus (accent blue)'],
                                    ['--chart-axis', 'axis / grid / cursor'],
                                ].map(([token, label]) => (
                                    <div key={token} className="flex items-center gap-2 text-xs">
                                        <span
                                            className="inline-block h-4 w-8 shrink-0 rounded-sm border border-edge"
                                            style={{ backgroundColor: `var(${token})` }}
                                        />
                                        <code className="font-mono text-ink-secondary">{token}</code>
                                        <span className="text-ink-muted">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </Section>

                <Section
                    title="X axis across every DaysFilter window"
                    note="Hourly data, so these are 24 / 72 / 168 / 336 / 720 points. Two labels only — first and last. The first should start flush against the Y axis, the last finish flush with the final datapoint, neither hanging past the plot. Only the 1-day window formats as times; the rest are dates."
                >
                    <div className="space-y-4">
                        {WINDOWS.map(days => {
                            const rows = makeSnapshots(days)
                            return (
                                <div key={days} className="grid grid-cols-1 gap-3 sm:grid-cols-[7rem_1fr] sm:items-center">
                                    <div className="text-xs">
                                        <p className="font-semibold text-ink">days={days}</p>
                                        <p className="text-ink-muted">{rows.length} points</p>
                                        <p className="text-ink-muted">{days <= 1 ? 'times' : 'dates'}</p>
                                    </div>
                                    <MetricsChartCard
                                        title="Total Vulnerabilities"
                                        description={`Last ${days === 1 ? '24 hours' : `${days} days`}`}
                                        dataKey="totalVulnerabilities"
                                        data={rows}
                                        deltaDirection="up-bad"
                                        chartHeight={120}
                                        overlay="criticalAndHigh"
                                    />
                                </div>
                            )
                        })}
                    </div>
                </Section>

                <Section
                    title="A capture outage"
                    note="30 hours of missing snapshots two-thirds in. On the old category axis this rendered as a single one-hour step; on a time scale the gap is proportional and visible."
                >
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <MetricsChartCard
                            title="Total Vulnerabilities"
                            description="7 days, with a 30-hour worker outage"
                            dataKey="totalVulnerabilities"
                            data={makeSnapshots(7, { afterHours: 110, lengthHours: 30 })}
                            deltaDirection="up-bad"
                            chartHeight={180}
                            overlay="criticalAndHigh"
                        />
                        <MetricsChartCard
                            title="Total Vulnerabilities"
                            description="7 days, uninterrupted — for comparison"
                            dataKey="totalVulnerabilities"
                            data={makeSnapshots(7)}
                            deltaDirection="up-bad"
                            chartHeight={180}
                            overlay="criticalAndHigh"
                        />
                    </div>
                </Section>

                <Section title="Edge states" note="Empty, and a single data point — both used to render as a broken or cropped card.">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <MetricsChartCard
                            title="Total Vulnerabilities"
                            description="No snapshots at all"
                            dataKey="totalVulnerabilities"
                            data={[]}
                        />
                        <MetricsChartCard
                            title="Total Vulnerabilities"
                            description="Exactly one snapshot"
                            dataKey="totalVulnerabilities"
                            data={snapshots.slice(0, 1)}
                        />
                        <StatPanel
                            cells={[
                                { key: 'w', label: 'Running containers', value: last.totalWorkloads, delta: last.totalWorkloads - first.totalWorkloads },
                                { key: 'c', label: 'Components', value: last.totalComponents, delta: last.totalComponents - first.totalComponents },
                            ]}
                        />
                    </div>
                </Section>
            </div>
        </main>
    )
}

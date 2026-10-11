'use client';

import type { TooltipContentProps, TooltipProps } from 'recharts';
import { formatTimestamp } from '@/lib/chart-time';
import { CHART_CURSOR } from '@/lib/chart-theme';

/**
 * The hover readout, shared by every chart.
 *
 * Recharts' own tooltip is a `<div>` with hardcoded inline styles — `padding: 10px`
 * on the box, then another `4px` above *and below* each item inside it. `contentStyle`
 * can repaint the surface but cannot reach the items, so the box came out padded 10px
 * at the top and 14px at the bottom, with the date crowding the top edge and the rows
 * drifting apart. None of those numbers are on Primer's 4px spacing scale either.
 *
 * So this replaces the content wholesale rather than restyling it: `12px/8px` padding,
 * `4px` between rows, `8px` under the date, all in Tailwind tokens like the rest of
 * the UI. The row shape — a line key, the series name, then the value hard right in
 * `tabular-nums` — is deliberately the same as `MetricsChartCard`'s legend, so hovering
 * a chart shows the reading in the form the card already taught.
 */

/** Recharts clones this element with the live tooltip props, so on the first render
 *  (as `content={<ChartTooltipContent />}`) every one of them is still absent. */
type ChartTooltipContentProps = Partial<TooltipContentProps<number, string>> & {
    /** Overrides the default `toLocaleString()` — for a unit, a percentage, bytes. */
    valueFormatter?: (value: number) => string;
};

const formatValue = (value: number) => value.toLocaleString();

export function ChartTooltipContent({
    active,
    payload,
    label,
    // Defaults live on the parameters, not in `chartTooltipProps` below: Recharts
    // clones this element with the `<Tooltip>`'s own props spread over ours, so a
    // formatter set there would be overwritten by an explicit `undefined` the moment
    // a chart doesn't pass one.
    labelFormatter = formatTimestamp,
    valueFormatter = formatValue,
}: ChartTooltipContentProps) {
    if (!active || !payload?.length) return null;

    const rows = payload.filter((entry) => entry.value != null);
    if (!rows.length) return null;

    return (
        <div className="min-w-36 rounded-md border border-edge bg-surface-overlay px-3 py-2 text-xs shadow-floating">
            {label != null && <p className="text-ink-muted whitespace-nowrap">{labelFormatter(label, payload)}</p>}
            <ul className="mt-2 flex flex-col gap-1">
                {rows.map((entry, i) => (
                    <li
                        key={String(entry.dataKey ?? entry.name ?? i)}
                        className="flex items-center gap-2 whitespace-nowrap"
                    >
                        {/* A line key, not a filled swatch — same reasoning as the legend:
                            at this size a block of series colour is data-weight ink doing
                            a label's job. It is decoration here, since the row names the
                            series in words right next to it. */}
                        <span
                            aria-hidden="true"
                            className="h-0.5 w-3 shrink-0 rounded-full"
                            style={{ backgroundColor: entry.color }}
                        />
                        <span className="text-ink-secondary">{entry.name}</span>
                        {/* `ml-auto` right-aligns the values into a column, and the box is
                            sized by its widest row, so two series line up without a grid. */}
                        <span className="ml-auto pl-3 font-medium text-ink tabular-nums">
                            {valueFormatter(entry.value as number)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/**
 * Spread onto every `<Tooltip>`: `<Tooltip {...chartTooltipProps} />`.
 *
 * A chart adds only what is genuinely its own — `position`, `allowEscapeViewBox` —
 * and names its series with `name` on the `<Area>` rather than through a `formatter`,
 * so the tooltip and the legend read the same label from the same place.
 */
export const chartTooltipProps = {
    cursor: CHART_CURSOR,
    content: <ChartTooltipContent />,
    // The wrapper is a positioned div Recharts owns; `globals.css` rings focusable
    // chart internals in `--accent`, and this one is not one of them.
    wrapperStyle: { outline: 'none' },
} satisfies Partial<TooltipProps<number, string>>;

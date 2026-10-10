import { ShieldAlert } from 'lucide-react'
import {
    riskBand,
    explainRisk,
    RISK_SCALE_HINT,
    TOTAL_RISK_HINT,
    type RiskBand,
    type RiskInputs,
    type RiskRollup,
} from '@/lib/risk'

/**
 * Two numbers, and the working.
 *
 * A **finding** contributes 0–100 ({@link RiskChip}); a **group** — image,
 * workload, release, cluster, org — carries the **Radar Score**, the unbounded
 * sum of those contributions ({@link TotalRiskChip}, ADR 0007). The brand name
 * belongs to the sum, never the per-finding number (`lib/risk.ts`). The two
 * are deliberately rendered differently: the finding chip wears its `/100`
 * denominator inside a pill, the Radar Score is a bare number — no pill, no
 * background, just tabular figures with thousands separators — and its colour
 * comes from the group's *worst finding* rather than from the number itself.
 *
 * Neither ever renders as an uninterrogable bare number — a score the customer
 * cannot argue with is the thing that undoes the credibility of findings that
 * are otherwise traceable to a public advisory. The inputs are always one
 * hover away, and on the wider surfaces they are on the row.
 *
 * Colour comes from the semantic tokens, so the bands mean the same thing here
 * as severity does elsewhere without either borrowing the other's palette.
 */

const bandStyles: Record<RiskBand, string> = {
    critical: 'text-danger bg-danger-subtle ring-danger-muted',
    high: 'text-danger bg-danger-subtle ring-danger-muted',
    medium: 'text-attention bg-attention-subtle ring-attention-muted',
    low: 'text-neutral bg-neutral-subtle ring-neutral-muted',
    none: 'text-ink-muted bg-surface-muted ring-edge',
}

/** The Radar Score is a number in a column, not a badge: colour only, no box. */
const totalBandText: Record<RiskBand, string> = {
    critical: 'text-danger',
    high: 'text-danger',
    medium: 'text-attention',
    low: 'text-ink',
    none: 'text-ink-muted',
}

/** Score chips are numbers — tabular figures so a column of them lines up. */
const chipBase =
    'inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset'

export function RiskChip({
    score,
    title,
    className = '',
}: {
    score: number | null | undefined
    title?: string
    className?: string
}) {
    // Not zero. An unscanned image has no score, and painting it "0" puts it
    // in the same bucket as one we checked and found clean — the same
    // distinction the severity cell already protects.
    if (score == null) {
        return (
            <span className="text-ink-muted" title="No SBOM for this image yet">
                —
            </span>
        )
    }

    const band = riskBand(score)
    return (
        <span className={`${chipBase} ${bandStyles[band]} ${className}`} title={title ?? RISK_SCALE_HINT}>
            {Math.round(score)}
            {/* The denominator rides on every finding chip because "72" alone
                reads as anything — a count, a CVSS×10, a percentile. Weight,
                not colour, sets it back, so it passes the same contrast the
                score does. It is also what visually separates a finding's
                bounded score from a group's unbounded total. */}
            <span className="font-normal">/100</span>
        </span>
    )
}

/**
 * A group's Radar Score — the unbounded sum of its findings' contributions.
 *
 * No denominator, because there is none: the number falls as findings are
 * fixed and has no ceiling. And no pill: a total is a magnitude to be read
 * down a column, not a status to be spotted, so it renders as plain tabular
 * text. Colour comes from `band` — the band of the group's worst finding,
 * supplied by the server — because banding the total itself would paint every
 * large group critical regardless of what is in it. A caller holding only a
 * bare total (no rollup) omits `band` and gets muted text: an honest "we know
 * how much, not how urgent".
 */
export function TotalRiskChip({
    score,
    band,
    title,
    className = '',
}: {
    score: number | null | undefined
    band?: RiskBand
    title?: string
    className?: string
}) {
    // Not zero — an unscanned group has no total, same distinction as RiskChip.
    if (score == null) {
        return (
            <span className="text-ink-muted" title="No SBOM for this image yet">
                —
            </span>
        )
    }

    return (
        <span
            className={`font-semibold tabular-nums ${totalBandText[band ?? 'none']} ${className}`}
            title={title ?? TOTAL_RISK_HINT}
        >
            {Math.round(score).toLocaleString()}
        </span>
    )
}

/**
 * CISA KEV as a **state**, not a higher number.
 *
 * The score already accounts for KEV membership, and on a low-severity advisory
 * it still lands well down the list — correctly, because the consequence is
 * small. What the number cannot say is *someone is exploiting this right now*,
 * which is a different kind of fact from a probability and deserves its own
 * mark rather than a few more points.
 */
export function KevBadge({
    count,
    dueDate,
    ransomware,
}: {
    count?: number
    dueDate?: string | null
    ransomware?: string | null
}) {
    if (count !== undefined && count <= 0) return null

    const detail = [
        'Confirmed exploited in the wild (CISA KEV)',
        dueDate ? `CISA remediation due ${new Date(dueDate).toISOString().slice(0, 10)}` : null,
        ransomware === 'Known' ? 'Used in known ransomware campaigns' : null,
    ]
        .filter(Boolean)
        .join(' · ')

    return (
        <span
            title={detail}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-subtle px-1.5 py-px text-[11px] font-medium text-danger ring-1 ring-inset ring-danger-muted"
        >
            <ShieldAlert aria-hidden="true" className="size-3" />
            KEV{count !== undefined && count > 1 ? ` ×${count}` : ''}
        </span>
    )
}

/**
 * The score with its rollup context — the workloads-list and images-list cell.
 *
 * `topFinding` is on the tooltip rather than the row because it answers a
 * question the reader only asks once they have decided to look: the number
 * orders the list, the advisory id explains one row of it.
 *
 * KEV here is an icon *leading* the chip, not the full {@link KevBadge}
 * trailing it. The cell lives in right-aligned columns, where anything after
 * the chip pushes the score off the column's shared right edge — and a column
 * of totals that doesn't line up can't be scanned, which is the one job the
 * column has. The icon carries the same danger colour and tooltip; the badge
 * with its label stays for the detail surfaces, where nothing is aligned
 * under it.
 */
export function RiskCell({ risk }: { risk: RiskRollup | null }) {
    if (!risk) return <TotalRiskChip score={null} />

    const title = [
        `Radar Score ${Math.round(risk.score).toLocaleString()} — summed over ${risk.findingCount} finding${risk.findingCount === 1 ? '' : 's'}`,
        risk.topFinding ? `Worst finding: ${risk.topFinding.vulnId} (${Math.round(risk.topFinding.risk)}/100)` : null,
        risk.kevCount > 0 ? `${risk.kevCount} on CISA KEV` : null,
        risk.exploitedCount > 0 ? `${risk.exploitedCount} with EPSS ≥ 0.1` : null,
        TOTAL_RISK_HINT,
    ]
        .filter(Boolean)
        .join('\n')

    return (
        <span className="inline-flex items-center gap-1.5">
            {risk.kevCount > 0 && (
                <span
                    title={`${risk.kevCount} confirmed exploited in the wild (CISA KEV)`}
                    className="inline-flex shrink-0 text-danger"
                >
                    <ShieldAlert aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">{risk.kevCount} on CISA KEV</span>
                </span>
            )}
            <TotalRiskChip score={risk.score} band={risk.band} title={title} />
        </span>
    )
}

/**
 * "KEV since 2021-12-10 · EPSS 0.974 (99th pct) · CVSS 10.0"
 *
 * The per-finding version, for a detail row that has the width for it. Every
 * clause is a public fact; an advisory FIRST.org does not score reads
 * `EPSS —`, never the stand-in the model uses internally.
 */
export function RiskInputsLine({ inputs }: { inputs: RiskInputs }) {
    return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            {inputs.kevListedAt && (
                <KevBadge dueDate={inputs.kevDueDate} ransomware={inputs.kevRansomware} />
            )}
            {explainRisk(inputs)
                .filter(part => !part.startsWith('On CISA KEV'))
                .map(part => (
                    <span key={part}>{part}</span>
                ))}
        </span>
    )
}

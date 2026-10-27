'use client';

import { Fragment } from 'react';
import { AlertCircle, CheckCircle, Table2 } from 'lucide-react';
import { Spinner, VulnerabilityCounts } from '@/components/ui';
import { PLAN_NAMES } from '@/components/organization-settings/constants';
import { formatNumber, formatMax, type HealthTone } from './utils';
import type { EcosystemEntry, SeverityCounts } from './types';

// ── TabShell ───────────────────────────────────────────────────────────────

export function TabShell({
    isLoading,
    error,
    onRetry,
    children,
}: {
    isLoading: boolean;
    error: string | null;
    onRetry: () => void;
    children: React.ReactNode;
}) {
    if (isLoading) {
        return (
            <div className="flex justify-center py-16">
                <Spinner size="lg" className="text-ink-faint" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="rounded-md bg-danger-subtle border border-danger-muted p-6 flex items-start gap-3">
                <AlertCircle className="size-5 text-danger shrink-0 mt-0.5" />
                <div>
                    <p className="font-medium text-danger">Failed to load</p>
                    <p className="text-sm text-danger mt-0.5">{error}</p>
                    <button onClick={onRetry} className="mt-3 text-sm text-danger underline cursor-pointer">
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}

// ── DB-admin table helpers ───────────────────────────────────────────────────
//
// These started private to the Explorer. The Images tab reads the same way — a
// table of database rows, annotated with where they came from — so they moved
// here rather than being copied, which is how the two would have drifted into
// showing the same severity counts in two different shapes.

function sevTotal(c: SeverityCounts): number {
    return c.critical + c.high + c.medium + c.low + c.unknown;
}

// DB-admin cue: shows which server-DB table(s) a section is sourced from.
// Multiple names render as a join (⋈) to mirror the underlying query.
function TableTag({ name }: { name: string }) {
    return (
        <span className="inline-flex items-center gap-1 font-mono text-[11px] leading-none text-info bg-info-subtle border border-info-muted px-1.5 py-1 rounded-sm">
            <Table2 className="size-3 text-info" />
            {name}
        </span>
    );
}

export function SourceTables({ tables }: { tables: string[] }) {
    return (
        <span className="inline-flex items-center gap-1.5 flex-wrap" title="Source table(s) in the server database">
            {tables.map((t, i) => (
                <Fragment key={t}>
                    {i > 0 && (
                        <span className="text-ink-faint text-xs font-mono" aria-hidden>
                            ⋈
                        </span>
                    )}
                    <TableTag name={t} />
                </Fragment>
            ))}
        </span>
    );
}

// Inline `column: value` for a primary key / id, monospace.
export function KeyHint({ column, value }: { column: string; value: string }) {
    return (
        <span className="font-mono text-[11px] text-ink-muted">
            <span className="text-ink-muted">{column}</span>
            <span className="text-ink-muted"> = </span>
            <span className="text-ink-muted">{value}</span>
        </span>
    );
}

export function SevCounts({ counts }: { counts: SeverityCounts }) {
    if (sevTotal(counts) === 0) {
        return (
            <span className="inline-flex items-center gap-1 text-xs text-success">
                <CheckCircle className="size-3.5" /> None
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-2">
            <VulnerabilityCounts
                critical={counts.critical}
                high={counts.high}
                medium={counts.medium}
                low={counts.low}
            />
            {counts.unknown > 0 && <span className="text-xs text-ink-muted">+{counts.unknown} unknown</span>}
        </span>
    );
}

export function ErrorBox({ message }: { message: string }) {
    return (
        <div className="rounded-md bg-danger-subtle border border-danger-muted p-6 flex items-start gap-3">
            <AlertCircle className="size-5 text-danger shrink-0 mt-0.5" />
            <p className="text-sm text-danger">{message}</p>
        </div>
    );
}

export function LoadingBox() {
    return (
        <div className="flex justify-center py-16">
            <Spinner size="lg" className="text-ink-faint" />
        </div>
    );
}

// ── StatCard ───────────────────────────────────────────────────────────────

/**
 * `tone` colours the figure only, never the card. A grid of stat cards is read
 * by scanning down the numbers; tinting a whole card pulls the eye to the box
 * instead, and a row where several cards are tinted stops distinguishing them.
 */
export function StatCard({
    icon: Icon,
    label,
    value,
    sub,
    tone = 'neutral',
}: {
    icon: React.ElementType;
    label: string;
    value: string | number;
    sub?: string;
    tone?: HealthTone;
}) {
    const figure: Record<HealthTone, string> = {
        neutral: 'text-ink',
        good: 'text-success',
        warn: 'text-attention',
        bad: 'text-danger',
    };

    return (
        <div className="bg-surface-raised rounded-md border border-edge p-4 flex items-start gap-3">
            <div className="p-2 rounded-md bg-surface-muted">
                <Icon className="size-4.5 text-ink-muted" />
            </div>
            <div className="min-w-0">
                <p className="text-xs text-ink-muted font-medium uppercase tracking-wide">{label}</p>
                <p className={`text-2xl font-bold mt-0.5 ${figure[tone]}`}>
                    {typeof value === 'number' ? formatNumber(value) : value}
                </p>
                {sub && <p className="text-xs text-ink-muted mt-0.5">{sub}</p>}
            </div>
        </div>
    );
}

// ── HealthTile ─────────────────────────────────────────────────────────────

/**
 * A figure whose colour is the finding, and a line of prose saying what the
 * figure means *at that value* rather than what the column is.
 *
 * `bad` is reserved for numbers that mean something is wrong right now, so a
 * healthy dashboard carries no red and a red tile is never ambient. Started as
 * the withdrawn-advisory panel's private tile; the job-queue and matcher panels
 * ask the same shape of question.
 */
export function HealthTile({
    label,
    value,
    tone,
    detail,
    children,
}: {
    label: string;
    value: string | number;
    tone: HealthTone;
    detail: string;
    /** Below the sentence: a link, or the one row the figure summarises. */
    children?: React.ReactNode;
}) {
    const box: Record<HealthTone, string> = {
        neutral: 'border-edge bg-surface-muted',
        good: 'border-success-muted bg-success-subtle',
        warn: 'border-attention-muted bg-attention-subtle',
        bad: 'border-danger-muted bg-danger-subtle',
    };
    const figure: Record<HealthTone, string> = {
        neutral: 'text-ink',
        good: 'text-success',
        warn: 'text-attention',
        bad: 'text-danger',
    };

    return (
        <div className={`rounded-md border p-4 ${box[tone]}`}>
            <p className="text-xs text-ink-muted font-medium uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-0.5 ${figure[tone]}`}>
                {typeof value === 'number' ? formatNumber(value) : value}
            </p>
            <p className="text-xs text-ink-muted mt-1">{detail}</p>
            {children}
        </div>
    );
}

// ── DistributionBar ────────────────────────────────────────────────────────

export interface BarSegment {
    key: string;
    label: string;
    count: number;
    /** A `bg-*-emphasis` token. Colour carries the category, so it must be stable per key. */
    className: string;
}

/**
 * One bar of proportions plus a legend of the same segments.
 *
 * Both halves are needed: the bar makes a shifted proportion visible at a glance
 * — which is the whole point of an aggregate over per-row metadata — and the
 * legend carries the counts, because a share alone cannot tell 3 of 4 from
 * 30,000 of 40,000. Zero-count segments are dropped from both rather than drawn
 * as slivers.
 */
export function DistributionBar({
    segments,
    total,
    emptyMessage,
}: {
    segments: BarSegment[];
    total: number;
    emptyMessage: string;
}) {
    if (total === 0) return <p className="text-sm text-ink-muted">{emptyMessage}</p>;

    const present = segments.filter((s) => s.count > 0);

    return (
        <div className="space-y-2">
            <div className="flex h-2.5 rounded-full overflow-hidden bg-track gap-px">
                {present.map((s) => (
                    <div
                        key={s.key}
                        className={`${s.className} h-full`}
                        style={{ width: `${(s.count / total) * 100}%` }}
                        title={`${s.label}: ${formatNumber(s.count)}`}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
                {present.map((s) => (
                    <div key={s.key} className="flex items-center gap-1.5 text-xs text-ink-secondary">
                        <span className={`size-2 rounded-full ${s.className}`} />
                        {s.label}: <span className="font-medium">{formatNumber(s.count)}</span>
                        <span className="text-ink-muted">({((s.count / total) * 100).toFixed(1)}%)</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── SeverityBar ────────────────────────────────────────────────────────────

const SEVERITY_SEGMENTS: Array<{ key: string; label: string; className: string }> = [
    { key: 'critical', label: 'Critical', className: 'bg-sev-critical-emphasis' },
    { key: 'high', label: 'High', className: 'bg-sev-high-emphasis' },
    { key: 'medium', label: 'Medium', className: 'bg-sev-medium-emphasis' },
    { key: 'low', label: 'Low', className: 'bg-sev-low-emphasis' },
    { key: 'unknown', label: 'Unknown', className: 'bg-edge-strong' },
];

export function SeverityBar({ bySeverity, total }: { bySeverity: Record<string, number>; total: number }) {
    return (
        <DistributionBar
            segments={SEVERITY_SEGMENTS.map((s) => ({ ...s, count: bySeverity[s.key] ?? 0 }))}
            total={total}
            emptyMessage="No vulnerabilities in database"
        />
    );
}

// ── EcosystemChart ─────────────────────────────────────────────────────────

export function EcosystemChart({ entries }: { entries: EcosystemEntry[] }) {
    if (entries.length === 0) return <p className="text-sm text-ink-muted">No ecosystem data yet.</p>;
    const max = entries[0]?.count ?? 1;
    const maxLabelLen = Math.max(...entries.map((e) => e.ecosystem.length));
    return (
        <div className="space-y-2">
            {entries.map((e) => (
                <div key={e.ecosystem} className="flex items-center gap-3">
                    <span
                        className="text-xs text-ink-secondary font-mono shrink-0"
                        style={{ minWidth: `${maxLabelLen}ch` }}
                    >
                        {e.ecosystem}
                    </span>
                    <div className="flex-1 h-1.5 bg-track rounded-full overflow-hidden">
                        <div
                            className="h-full bg-accent-emphasis rounded-full"
                            style={{ width: `${(e.count / max) * 100}%` }}
                        />
                    </div>
                    <span className="text-xs font-medium text-ink-secondary w-16 text-right">
                        {formatNumber(e.count)}
                    </span>
                </div>
            ))}
        </div>
    );
}

// ── PlanBadge ──────────────────────────────────────────────────────────────

/**
 * The stored plan value as it is sold: `team` is "Business", `free` is
 * "No plan" (`PLAN_NAMES`); a value the client does not know is shown raw.
 */
export function PlanBadge({ plan }: { plan: string }) {
    const colors: Record<string, string> = {
        free: 'bg-surface-hover text-ink-secondary',
        pro: 'bg-accent-subtle text-accent',
    };
    return (
        <span
            className={`text-xs px-1.5 py-0.5 rounded-sm font-medium ${colors[plan] ?? 'bg-surface-hover text-ink-secondary'}`}
        >
            {(PLAN_NAMES as Record<string, string>)[plan] ?? plan}
        </span>
    );
}

export { formatMax };

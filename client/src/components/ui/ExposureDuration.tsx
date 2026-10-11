import { formatShortDate } from '@/utils/formatters';
import type { ExposureLowerBoundReason } from '@/types/cluster';

const DAY_MS = 86_400_000;

/*
 * A free organization meets the second of these after about 30 days, and it
 * is the natural place for an upgrade prompt later. Deliberately a sentence
 * and not a link for now (exposure plan, item 3.5).
 */
const REASONS: Record<ExposureLowerBoundReason, string> = {
    'first-observation': 'Already running when StackRadar first saw this cluster',
    'history-unavailable': "Older image history is outside your plan's history window",
    unscanned: 'The image that ran before was never scanned',
};

/**
 * "143 d", "5 mo", "2.4 y" — days under 90, then months, then years. Never
 * hours: a duration is only as precise as the inventory report that dated
 * it, and hours would be a precision we do not have.
 */
export function formatExposure(since: string | Date, isLowerBound = false, now: Date = new Date()): string {
    const days = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY_MS));
    const prefix = isLowerBound ? '≥ ' : '';
    if (days < 1) return isLowerBound ? '≥ 0 d' : '< 1 d';
    if (days < 90) return `${prefix}${days} d`;
    const months = Math.floor(days / 30.44);
    if (months < 24) return `${prefix}${months} mo`;
    return `${prefix}${(Math.floor((days / 365.25) * 10) / 10).toFixed(1)} y`;
}

/** The hover text: the absolute date, and for a lower bound, why it is one. */
export function exposureTitle(
    since: string | Date,
    isLowerBound = false,
    reason?: ExposureLowerBoundReason | null,
): string {
    const date = formatShortDate(new Date(since).toISOString());
    if (!isLowerBound) return `Since ${date}`;
    return `Since ${date} or earlier. ${REASONS[reason ?? 'history-unavailable']}.`;
}

/**
 * How long something has been running, exposed or known-exploited. A lower
 * bound is rendered as one ("≥ 30 d") and never as an exact figure; a
 * duration that could not be computed is "—", never zero.
 */
export function ExposureDuration({
    since,
    isLowerBound = false,
    reason,
    className,
}: {
    since: string | Date | null | undefined;
    isLowerBound?: boolean;
    reason?: ExposureLowerBoundReason | null;
    className?: string;
}) {
    if (!since) {
        return (
            <span className={className} title="Not measured yet">
                —
            </span>
        );
    }
    return (
        <span
            className={`tabular-nums whitespace-nowrap ${className ?? ''}`}
            title={exposureTitle(since, isLowerBound, reason)}
        >
            {formatExposure(since, isLowerBound)}
        </span>
    );
}

import { CONTROL_FILTER_PARAM, type ControlFilter } from '@/lib/image-control';
import { withTierParam, type TierLens } from '@/lib/tier-lens';

/** The longest window the movement endpoint answers; the page's longer ranges read this much of it. */
export const MAX_DAYS = 90;
/**
 * The bands the block opens on. A week of advisory syncs lands mediums and
 * lows on most images; critical and high are what a reader acts on, and the
 * rest are one toggle away.
 */
const ACTIONABLE = ['critical', 'high'] as const;

/** What the block is scoped by: the page's three filters, and its own band toggle. */
export type MovementFilters = {
    /** The page's date range, in days. */
    days: number;
    /** Whose images — the page's scope, shared with "Most critical". */
    control: ControlFilter;
    /** The page's findings lens: an arrival outside it is not listed. */
    lens: TierLens;
    /** Off: critical and high only. On: every band. */
    includeLower: boolean;
};

/** The block's query string, in a fixed order so the same view is the same request. */
export function movementQuery({ days, control, lens, includeLower }: MovementFilters): string {
    const params = new URLSearchParams({ days: String(Math.min(days, MAX_DAYS)) });
    if (!includeLower) params.set('severity', ACTIONABLE.join(','));
    if (control !== 'all') params.set(CONTROL_FILTER_PARAM, control);
    return withTierParam(params, lens).toString();
}

/** Where the block's list is read from — the page fetches it, under the scope it shares with the other block. */
export const movementUrl = (filters: MovementFilters) => `/api/feed/movement?${movementQuery(filters)}`;

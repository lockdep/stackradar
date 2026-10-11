import { SeverityDelta } from '@/components/ui';
import type { SeverityBreakdown } from '@/types/feed';
import { EMPTY_BREAKDOWN, scoredTotal } from './dayGroups';

/**
 * The trailing columns of a feed row — cluster and time — as class strings,
 * so the day header can reserve the same widths with empty spans and its
 * summary lands in the same column as the rows' counters beneath it.
 *
 * Both collapse below `sm`: at 390px the subject and its counters are the
 * row, the day heading already says which day, and the cluster is in the
 * expansion. The day header's spacers carry the same classes, so they
 * collapse in step.
 */
export const CLUSTER_COL = 'hidden w-32 shrink-0 sm:inline';
export const TIME_COL = 'hidden w-11 shrink-0 sm:inline';

/**
 * The two blocks of severity squares a change can carry — findings that left
 * and findings that arrived — in a fixed order, right-aligned, so the
 * "arrived" block sits in the same column on every row and in the day
 * summary. When only the left block has anything to say, an invisible right
 * block keeps it out of the arrived column.
 */
export function SeverityDeltaPair({
    removed,
    added,
    removedNoun,
    addedNoun,
}: {
    removed: SeverityBreakdown | null;
    added: SeverityBreakdown | null;
    removedNoun: string;
    addedNoun: string;
}) {
    const showRemoved = removed !== null && scoredTotal(removed) > 0;
    const showAdded = added !== null && scoredTotal(added) > 0;
    if (!showRemoved && !showAdded) return null;
    return (
        <>
            {showRemoved && <SeverityDelta sign="−" counts={removed} noun={removedNoun} />}
            {showAdded ? (
                <SeverityDelta sign="+" counts={added} noun={addedNoun} />
            ) : (
                <span aria-hidden className="invisible">
                    <SeverityDelta sign="+" counts={EMPTY_BREAKDOWN} noun={addedNoun} />
                </span>
            )}
        </>
    );
}

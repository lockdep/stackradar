import { Tooltip } from '@/components/ui';

/** What a container's Age counts from — and, as pointedly, what it does not. */
export const AGE_COLUMN_HINT =
    'How long the container has run this exact image. Exposure across earlier images is on the container’s page.';

/**
 * The containers list's "Age" column header: the word, with its definition
 * one hover away. Age here is the time on *this* digest, which a rollout
 * resets — not how long the workload has existed, and not how long a finding
 * has been exposed — and nothing in the word says so.
 *
 * Not its own tab stop: it sits inside `SortableHeader`'s button, whose
 * keyboard focus opens the bubble. `align="end"` because the column is
 * right-aligned and sits near the table's edge.
 */
export function AgeColumnLabel() {
    return (
        <Tooltip text={AGE_COLUMN_HINT} align="end" focusable={false}>
            Age
        </Tooltip>
    );
}

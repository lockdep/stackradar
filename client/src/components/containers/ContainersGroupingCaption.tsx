function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The line that says what the reader is looking at.
 *
 * It carries the one rule that makes the numbers add up: counts are per
 * distinct image. The table footer says `(per distinct image)` about its own
 * total, but every group row is deduplicated the same way, and a namespace
 * whose count is smaller than the sum of its rows reads as a bug until
 * something says otherwise.
 */
export function ContainersGroupingCaption({
    grouping = 'namespace',
    groupCount,
    containerCount,
    imageCount,
    /** True while a search is narrowing the list, so the counts say what they count. */
    filtered = false,
}: {
    /**
     * `'namespace'` is the cluster tab's tree; `'flat'` is the org page's
     * single worst-first list, which has no groups to count.
     */
    grouping?: 'namespace' | 'flat';
    /** The number of namespace groups — omitted for a flat list. */
    groupCount?: number;
    containerCount: number;
    imageCount: number;
    filtered?: boolean;
}) {
    return (
        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-edge pb-3">
            <p className="text-xs text-ink-muted">
                {grouping === 'flat' ? (
                    <>
                        <span className="font-medium text-ink-secondary">Worst first</span>
                        <span className="mx-1.5 text-ink-faint">·</span>
                        Every running container in the organisation, by Risk Score.
                    </>
                ) : (
                    <>
                        <span className="font-medium text-ink-secondary">Grouped by namespace</span>
                        <span className="mx-1.5 text-ink-faint">·</span>
                        Every running container, under the namespace it runs in.
                    </>
                )}
            </p>
            {/* Images counted separately from containers because they are the
                unit the severity numbers are in — thirty containers on four
                images is four things to fix, and the gap between those two
                numbers is the whole reason the totals look short. */}
            <p className="text-xs text-ink-muted whitespace-nowrap">
                {filtered && <span>Matching: </span>}
                {[
                    ...(groupCount === undefined ? [] : [plural(groupCount, 'namespace')]),
                    plural(containerCount, 'container'),
                    plural(imageCount, 'image'),
                ].map((segment, i) => (
                    <span key={segment}>
                        {i > 0 && <span className="mx-1.5 text-ink-faint">·</span>}
                        {segment}
                    </span>
                ))}
            </p>
        </div>
    );
}

import type { ContainerFilter } from '@/types/container'

/**
 * How much of this cluster the list can actually speak for, directly above the
 * list — and a way to see the part it cannot.
 *
 * One compact gauge — "12/47 scanned" — rather than a full-width bar with a
 * labelled segment per state. The count pair carries everything the two
 * segments did: the denominator is the cluster, the numerator is what has an
 * SBOM, and the difference is the gap.
 *
 * The whole gauge is one button, and it toggles the *unscanned* filter — the
 * gap is the thing somebody looking at a coverage number needs to click, and
 * `unscanned` has no other control (the filter bar deliberately leaves it out).
 *
 * The numbers are counted from the rows on this page rather than from
 * `GET /api/clusters/:id/coverage`, which counts the same containers on the
 * server. Not to save a request: the gauge's claim is "clicking this shows
 * exactly the missing rows", and two counts of one population — one fetched,
 * one filtered — can disagree for a few seconds after a scan lands. Counting
 * what is in front of the user is the version of that claim that cannot come
 * apart.
 *
 * `reported` is the honest-silence guard, and it comes from the cluster rather
 * than from the rows: `discoveredWorkloads: null` means the scanner has never
 * sent an inventory, and a 0%-coverage gauge would be a confident false
 * statement about someone's cluster.
 */
export function ContainersCoverageStrip({
    scanned,
    unscanned,
    reported,
    active,
    onToggle,
    noun = 'containers',
}: {
    scanned: number
    unscanned: number
    /** False when this cluster has never reported an inventory. */
    reported: boolean
    /** Whether the unscanned filter this gauge toggles is on. */
    active: boolean
    onToggle: (filter: ContainerFilter) => void
    /** What the rows are — the `/images` list counts images. */
    noun?: 'containers' | 'images'
}) {
    const total = scanned + unscanned
    if (!reported || total === 0) return null

    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={() => onToggle('unscanned')}
            title={`Show only ${noun} with no SBOM`}
            /* On, it is a filter in force and is drawn as the bar's menus
               draw one: tinted, outlined and lettered in the accent colour. */
            className={`mt-3 inline-flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-xs ${
                active
                    ? 'bg-accent-subtle font-medium text-accent ring-1 ring-accent-emphasis hover:bg-accent-muted'
                    : 'text-ink-muted hover:text-ink-secondary'
            }`}
        >
            {/* min-w-0.5 keeps one scanned workload out of five hundred from
                rounding to an invisible fill. */}
            <span
                aria-hidden="true"
                className="flex h-1.5 w-32 overflow-hidden rounded-full bg-track"
            >
                {scanned > 0 && (
                    <span
                        className="h-full min-w-0.5 bg-accent-emphasis"
                        style={{ width: `${(scanned / total) * 100}%` }}
                    />
                )}
            </span>
            <span>
                {scanned.toLocaleString()}/{total.toLocaleString()} scanned
                {active && ' · showing unscanned only'}
            </span>
        </button>
    )
}

import type { FixListItem, NoRecommendationItem } from '@/types/fixes'

/**
 * How the fix list is sectioned. The server ranks moves (measured first, then
 * what clears the most Radar Score); the sections only decide which *kind* of
 * action a reader sees first, and the server's order holds inside each.
 *
 * Two questions, in this order:
 *
 *   1. **Who can make the move.** "In your control" — images the organization
 *      builds — before "Upgrade upstream": a public chart's newer version or
 *      a vendor image's newer tag. Third-party images with nothing to upgrade
 *      to are the folded third group, "Waiting on upstream".
 *   2. **What kind of work it is**, inside your control: a move that mostly
 *      clears **Application** packages before one that mostly clears the
 *      **Base image**. Upstream upgrades are not split — for a third-party
 *      image there is one action per image, whatever it clears.
 */
export type FixScope = 'application' | 'base'
export type FixSectionKey = 'yours-application' | 'yours-base' | 'upstream'

export const FIX_SECTION_LABEL: Record<FixSectionKey, string> = {
    'yours-application': 'In your control · Application',
    'yours-base': 'In your control · Base image',
    upstream: 'Upgrade upstream',
}

export const FIX_SECTION_HINT: Record<FixSectionKey, string> = {
    'yours-application': 'Images you build: moves that mostly clear findings in packages your build added.',
    'yours-base':
        'Images you build: moves that mostly clear findings in the base image — operating-system packages and the tooling that ships with the language.',
    upstream:
        'Third-party images: a newer version of a public chart, or a newer tag of a vendor image, overridden in your values. One action per image.',
}

const SECTION_ORDER: readonly FixSectionKey[] = ['yours-application', 'yours-base', 'upstream']

export interface FixSection {
    key: FixSectionKey
    fixes: FixListItem[]
}

/** A server older than the plan sends neither field; such a row is yours and the application's. */
export function sectionOf(fix: FixListItem): FixSectionKey {
    if (fix.control === 'third-party') return 'upstream'
    return fix.scope === 'base' ? 'yours-base' : 'yours-application'
}

/** Sections in order, empty ones dropped, the server's rank kept inside each. */
export function groupFixes(fixes: readonly FixListItem[]): FixSection[] {
    return SECTION_ORDER.map(key => ({ key, fixes: fixes.filter(f => sectionOf(f) === key) })).filter(
        s => s.fixes.length > 0
    )
}

/** The remainder, split: images you could act on, and third-party ones that can only wait. */
export function splitRemainder(items: readonly NoRecommendationItem[]): {
    yours: NoRecommendationItem[]
    waitingOnUpstream: NoRecommendationItem[]
} {
    return {
        yours: items.filter(i => i.control !== 'third-party'),
        waitingOnUpstream: items.filter(i => i.control === 'third-party'),
    }
}

/** A base rebuild is a move of an image; its icon and its page are the image's. */
export const fixEntityKind = (fix: FixListItem): 'image' | 'chart' => (fix.kind === 'chart' ? 'chart' : 'image')

/** The word on the row's kind badge. */
export const fixKindLabel = (fix: FixListItem): string =>
    fix.kind === 'chart' ? 'chart' : fix.kind === 'base' ? 'base image' : 'image'

/** "12 in application packages · 29 in the base image", or null when there is no split to show. */
export function clearedSplit(fix: FixListItem): string | null {
    const by = fix.cleared?.byScope
    if (!by || (by.application === 0 && by.base === 0)) return null
    if (by.base === 0) return 'all in application packages'
    if (by.application === 0) return 'all in the base image'
    return `${by.application.toLocaleString()} in application packages · ${by.base.toLocaleString()} in the base image`
}

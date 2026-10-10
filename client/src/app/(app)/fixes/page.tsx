import { notFound } from 'next/navigation'
import { FIXES_PAGE_ENABLED } from '@/lib/features'
import { FixesView } from '@/views'

/**
 * /fixes — every upgrade the product can recommend, across all clusters,
 * ranked by what it clears. The index over the recommendation panels on
 * `/images/[id]` and `/releases/[id]`, which used to be reachable only by
 * deep link.
 *
 * Disabled for now (`FIXES_PAGE_ENABLED`): the route 404s and the sidebar
 * entry is gone, but the view is kept.
 */
export default function FixesPage() {
    if (!FIXES_PAGE_ENABLED) notFound()
    return <FixesView />
}

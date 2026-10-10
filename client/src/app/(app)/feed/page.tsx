import { Suspense } from 'react'
import { FeedView } from '@/views'

/**
 * /feed — what changed in the fleet, one block per calendar day, newest
 * first. A second reader of `activity_events` beside the server's
 * `/api/remediation/activity` list (the Fixes page is read-only and has no
 * activity list of its own); day grouping happens here, in the viewer's timezone, exactly as the
 * workloads list groups by namespace at read time.
 * See docs/proposals/activity-feed.md.
 */
export default function FeedPage() {
    return (
        <Suspense>
            <FeedView />
        </Suspense>
    )
}

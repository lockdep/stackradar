import { Suspense } from 'react';
import { FeedView } from '@/views';

/**
 * /feed — what changed in the fleet, one block per calendar day, newest
 * first. The reader of `activity_events` (`GET /api/feed`); day grouping
 * happens here, in the viewer's timezone, exactly as the containers list
 * groups by namespace at read time.
 */
export default function FeedPage() {
    return (
        <Suspense>
            <FeedView />
        </Suspense>
    );
}

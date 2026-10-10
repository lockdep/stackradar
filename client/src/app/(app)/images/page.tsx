import { Suspense } from 'react'
import { ImagesView } from '@/views'

/**
 * /images — every image running in the organisation's clusters, one row per
 * image, worst first. The Suspense boundary is for the sort and scope
 * parameters, which read the URL.
 */
export default function ImagesPage() {
    return (
        <Suspense>
            <ImagesView />
        </Suspense>
    )
}

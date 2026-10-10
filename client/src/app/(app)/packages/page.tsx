import { Suspense } from 'react'
import { PackagesView } from '@/views'

/**
 * /packages — every cluster's Packages tab folded into one.
 * The Suspense boundary is for the `?search=` seed, which reads the URL.
 */
export default function PackagesPage() {
    return (
        <Suspense>
            <PackagesView />
        </Suspense>
    )
}

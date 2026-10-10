'use client'

import { OccurrencesPopover, occurrenceRows } from './OccurrencesPopover'
import { CONTROL_FILTER_PARAM, type ControlFilter } from '@/lib/image-control'
import type { PackageOccurrences } from '@/types/cluster'

type Props = {
    /**
     * Set on a cluster tab: the drill-down is the cluster's, and rows need
     * no cluster name. Absent on the org-wide list, where every row says
     * which cluster it is in and containers link into that cluster.
     */
    clusterId?: string
    packageName: string
    /** `null` is a versionless component, part of the package's identity. */
    version: string | null
    kind: 'images' | 'containers'
    /** The list's images filter, so the popover names the things the count counted. */
    control?: ControlFilter
    count: number
}

/**
 * A count cell of a package list that opens to the things it counts — the
 * images or containers one package version occurs in, each a link to its
 * detail page.
 */
export function PackageOccurrencesPopover({ clusterId, packageName, version, kind, control = 'all', count }: Props) {
    const params = new URLSearchParams({ name: packageName })
    if (version !== null) params.set('version', version)
    if (control !== 'all') params.set(CONTROL_FILTER_PARAM, control)
    const label = `${packageName}${version ? ` ${version}` : ''}`
    const base = clusterId ? `/api/clusters/${clusterId}/components` : '/api/components'

    return (
        <OccurrencesPopover<PackageOccurrences>
            count={count}
            ariaLabel={`${count} ${kind} with ${label} — show which`}
            url={`${base}/occurrences?${params}`}
            heading={
                kind === 'images'
                    ? `${label} is in these images`
                    : `${label} runs in these containers`
            }
            emptyNote={
                kind === 'images'
                    ? 'No scanned images carry this package any more.'
                    : 'Not running anywhere yet — the images are scanned, but nothing reported running them.'
            }
            rows={data => occurrenceRows(data, kind, { withCluster: !clusterId })}
        />
    )
}

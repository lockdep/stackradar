/**
 * The wire shape of `GET /api/search` — mirrors
 * `server/src/repositories/search.repository.ts`. The server returns ids,
 * never client URLs; `resultHref.ts` turns these into pages.
 */

export type SearchIntent = 'advisory' | 'image' | 'name'
export type SearchKind = 'vulnerability' | 'package' | 'image' | 'container' | 'cluster'

export type SearchVulnerabilityItem = {
    vulnId: string
    identity: string
    severity: 'critical' | 'high' | 'medium' | 'low' | null
    exploited: boolean
    kev: boolean
    imageCount: number
    workloadCount: number
    containerCount: number
}

export type SearchPackageItem = {
    name: string
    type: 'library'
    purlType: string | null
    versionCount: number
    /** Every occurrence is a distro package or runtime tooling — the row's small "base" tag. */
    base?: boolean
    imageCount: number
    workloadCount: number
    containerCount: number
}

export type SearchImageItem = {
    id: string
    registry: string | null
    repository: string | null
    tag: string | null
    clusterId: string
    clusterName: string
    lastSeenAt: string
}

export type SearchContainerItem = {
    workloadId: string
    containerId: string
    name: string
    kind: string | null
    namespace: string
    clusterId: string
    clusterName: string
}

export type SearchClusterItem = { id: string; name: string }

export type SearchGroup =
    | { kind: 'vulnerability'; items: SearchVulnerabilityItem[] }
    | { kind: 'package'; items: SearchPackageItem[] }
    | { kind: 'image'; items: SearchImageItem[] }
    | { kind: 'container'; items: SearchContainerItem[] }
    | { kind: 'cluster'; items: SearchClusterItem[] }

export type SearchResponse = {
    query: string
    intent: SearchIntent
    directHit: { kind: 'vulnerability'; vulnId: string } | null
    /** Ranked by intent; every kind is always present, possibly empty. */
    groups: SearchGroup[]
}

/** One item with its kind attached — what a palette row is built from. */
export type SearchHit =
    | { kind: 'vulnerability'; item: SearchVulnerabilityItem }
    | { kind: 'package'; item: SearchPackageItem }
    | { kind: 'image'; item: SearchImageItem }
    | { kind: 'container'; item: SearchContainerItem }
    | { kind: 'cluster'; item: SearchClusterItem }

/** Where the palette was opened from — the `search_opened` event's `source`. */
export type SearchSource = 'sidebar' | 'shortcut' | 'mobile'

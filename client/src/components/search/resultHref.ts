import type { SearchHit } from './types'

/**
 * The page each kind of result lands on. Pure, so the server can stay a
 * source of ids and the routing lives in exactly one place on the client.
 *
 * - vulnerability → the org's page for the advisory (any spelling resolves
 *   there, but we pass the server's canonical `vulnId`)
 * - package → the org-wide Packages list, searched (there is no per-package
 *   page; the list with the term applied *is* the package's page)
 * - image → the image page (`images.id`)
 * - container → the container page, whose unit is a `workload_containers` row
 * - cluster → the cluster page
 */
export function resultHref(hit: SearchHit): string {
    switch (hit.kind) {
        case 'vulnerability':
            return vulnerabilityHref(hit.item.vulnId)
        case 'package':
            return packagesSearchHref(hit.item.name)
        case 'image':
            return `/images/${encodeURIComponent(hit.item.id)}`
        case 'container':
            return `/clusters/${encodeURIComponent(hit.item.clusterId)}/containers/${encodeURIComponent(hit.item.containerId)}`
        case 'cluster':
            return `/clusters/${encodeURIComponent(hit.item.id)}`
    }
}

/** The org's page for one advisory — also the direct hit's row. */
export function vulnerabilityHref(vulnId: string): string {
    return `/vulnerabilities/${encodeURIComponent(vulnId)}`
}

/** The org-wide Packages list with a term applied — the palette's first fallback row. */
export function packagesSearchHref(term: string): string {
    return `/packages?search=${encodeURIComponent(term)}`
}

/** The org-wide Vulnerabilities list with a term applied — the second fallback row. */
export function vulnerabilitiesSearchHref(term: string): string {
    return `/vulnerabilities?search=${encodeURIComponent(term)}`
}

/** `registry/repository:tag`, omitting whatever the image does not carry. */
export function imageLabel(item: { registry: string | null; repository: string | null; tag: string | null }): string {
    const name = [item.registry, item.repository].filter(Boolean).join('/')
    const base = name || 'image'
    return item.tag ? `${base}:${item.tag}` : base
}

'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions, Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react'
import { CornerDownLeft, Search, ShieldAlert } from 'lucide-react'
import posthog from 'posthog-js'
import { EntityIcon, KevBadge, MENU_HEADING_CLASS, PackageIcon, Spinner, VulnerabilityBadge } from '@/components/ui'
import { imageLabel, packagesSearchHref, resultHref, vulnerabilitiesSearchHref, vulnerabilityHref } from './resultHref'
import { SEARCH_MIN_CHARS, useSearch } from './useSearch'
import type { SearchHit, SearchKind, SearchSource } from './types'

const GROUP_HEADING: Record<SearchKind, string> = {
    vulnerability: 'Vulnerabilities',
    package: 'Packages',
    image: 'Images',
    container: 'Containers',
    cluster: 'Clusters',
}

/**
 * One selectable row. `direct` is the synthetic first row the server's
 * `directHit` earns — Enter on a full advisory id goes straight to its page
 * even when the list below shows other rows. `fallback` rows are the two
 * permanent ones at the foot: the org-wide lists with the term applied, so
 * Enter on a term that matches nothing still lands somewhere useful.
 */
type Row =
    | { id: string; type: 'direct'; vulnId: string; href: string }
    | { id: string; type: 'hit'; hit: SearchHit; href: string; position: number }
    | { id: string; type: 'fallback'; target: 'packages' | 'vulnerabilities'; href: string }

type Section = { key: string; heading: string | null; rows: Row[] }

function plural(n: number, word: string) {
    return `${n} ${word}${n === 1 ? '' : 's'}`
}

function capture(event: string, props: Record<string, unknown>) {
    // No-op without a PostHog key (local dev). Never the query text.
    if (posthog.__loaded) posthog.capture(event, props)
}

/**
 * The palette: a dialog with one input and the grouped results under it, in
 * the server's order. Headless UI's Combobox owns the keyboard — arrows move
 * the focus ring, Enter selects the focused row (the first, by default), and
 * selecting navigates. The dialog closes on Escape and on the backdrop, and
 * returns focus to wherever it was.
 */
export function SearchPalette({
    isOpen,
    initialQuery,
    source,
    onClose,
}: {
    isOpen: boolean
    initialQuery: string
    source: SearchSource
    onClose: () => void
}) {
    const router = useRouter()
    const [query, setQuery] = useState(initialQuery)
    const { results, status } = useSearch(query, isOpen)

    // Each opening starts from what it was opened with — a character a
    // trigger forwarded, or nothing.
    useEffect(() => {
        if (isOpen) setQuery(initialQuery)
    }, [isOpen, initialQuery])

    /* Seeding the input with that character. Headless UI owns the input's
       text — it syncs it to the selected value (always null here) in its
       own effects after mount, which overwrites a `defaultValue` — so the
       seed is written once the input is attached and those effects have
       run, through the native setter plus an `input` event, which is what
       makes both React and the Combobox treat it as typed. */
    const seeded = useRef(false)
    useEffect(() => {
        if (!isOpen) seeded.current = false
    }, [isOpen])
    const seedInput = useCallback(
        (input: HTMLInputElement | null) => {
            if (!input || !initialQuery || seeded.current) return
            seeded.current = true
            // A macrotask, not requestAnimationFrame: rAF is paused in a
            // background tab, and the seed must land after Headless UI's
            // mount effects, not after the next paint.
            setTimeout(() => {
                if (!input.isConnected || input.value) return
                const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                setValue?.call(input, initialQuery)
                input.dispatchEvent(new Event('input', { bubbles: true }))
            })
        },
        [initialQuery],
    )

    const term = query.trim()
    const hasTerm = term.length >= SEARCH_MIN_CHARS

    const sections = useMemo<Section[]>(() => {
        if (!hasTerm) return []
        const out: Section[] = []
        let position = 0

        if (results?.directHit) {
            const vulnId = results.directHit.vulnId
            out.push({
                key: 'direct',
                heading: null,
                rows: [{ id: `direct:${vulnId}`, type: 'direct', vulnId, href: vulnerabilityHref(vulnId) }],
            })
        }

        for (const group of results?.groups ?? []) {
            if (group.items.length === 0) continue
            const rows: Row[] = group.items.map(item => {
                const hit = { kind: group.kind, item } as SearchHit
                return { id: `${group.kind}:${rowKey(hit)}`, type: 'hit', hit, href: resultHref(hit), position: position++ }
            })
            out.push({ key: group.kind, heading: GROUP_HEADING[group.kind], rows })
        }

        out.push({
            key: 'fallback',
            heading: null,
            rows: [
                { id: 'fallback:packages', type: 'fallback', target: 'packages', href: packagesSearchHref(term) },
                { id: 'fallback:vulnerabilities', type: 'fallback', target: 'vulnerabilities', href: vulnerabilitiesSearchHref(term) },
            ],
        })
        return out
    }, [hasTerm, results, term])

    const hitCount = sections.reduce((n, s) => n + s.rows.filter(r => r.type !== 'fallback').length, 0)
    /* Results for the current term have arrived and hold nothing; while an
       older set is still on screen, or the first request is in flight, the
       list stays as it is rather than flashing "no matches". */
    const isEmpty = hasTerm && status === 'ready' && results?.query === term && hitCount === 0

    const select = (row: Row | null) => {
        if (!row) return
        if (row.type === 'fallback') {
            capture('search_fallback', { target: row.target, queryLength: term.length, source })
        } else {
            capture('search_result_click', {
                kind: row.type === 'direct' ? 'vulnerability' : row.hit.kind,
                intent: results?.intent ?? null,
                position: row.type === 'direct' ? -1 : row.position,
                queryLength: term.length,
                directHit: row.type === 'direct',
                source,
            })
        }
        onClose()
        router.push(row.href)
    }

    return (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
            <DialogBackdrop className="fixed inset-0 bg-backdrop" />
            {/* Phone: pinned to the top with a 1rem gutter. Wider: a column
                at 15vh, the height a hand expects a palette at, as wide as
                the detail dialogs — container and image names run long
                (`kube-prometheus-stack-kube-state-metrics`,
                `registry.k8s.io/ingress-nginx/controller:v1.13.1`) and a
                narrow palette cut them off. */}
            <div className="fixed inset-0 overflow-y-auto p-4 sm:p-6 sm:pt-[15vh]">
                <DialogPanel className="mx-auto w-full max-w-3xl divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-floating">
                    <Combobox<Row | null> value={null} onChange={select}>
                        <div className="relative">
                            <Search
                                aria-hidden="true"
                                className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                            />
                            <ComboboxInput
                                ref={seedInput}
                                autoFocus
                                onChange={e => setQuery(e.target.value)}
                                aria-label="Search this organization"
                                placeholder="Search images, containers, CVEs and packages"
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck={false}
                                enterKeyHint="search"
                                className="h-12 w-full border-0 bg-transparent pl-11 pr-11 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
                            />
                            {status === 'loading' && (
                                <Spinner size="sm" className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted" />
                            )}
                        </div>

                        {!hasTerm && (
                            <p className="px-4 py-6 text-center text-sm text-ink-muted">
                                Search by CVE id, image, container, package or cluster name
                            </p>
                        )}

                        {hasTerm && (
                            <ComboboxOptions static as="div" className="max-h-[60vh] overflow-y-auto p-2 sm:max-h-96">
                                {status === 'error' && (
                                    <p className="px-2 py-3 text-sm text-ink-muted">Search is unavailable right now</p>
                                )}
                                {isEmpty && (
                                    <p className="px-2 py-3 text-sm text-ink-muted">
                                        No matches for “{term}” in this organization.
                                    </p>
                                )}
                                {sections.map(section => (
                                    <Fragment key={section.key}>
                                        {section.key === 'fallback' && hitCount > 0 && (
                                            <div className="mx-2 my-1 h-px bg-edge" />
                                        )}
                                        {section.heading && (
                                            <p className={`${MENU_HEADING_CLASS} mt-2 first:mt-0`}>{section.heading}</p>
                                        )}
                                        {section.rows.map(row => (
                                            <ComboboxOption
                                                key={row.id}
                                                value={row}
                                                className="group flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm text-ink data-focus:bg-surface-hover data-focus:outline-none"
                                            >
                                                <RowContent row={row} term={term} />
                                                <CornerDownLeft
                                                    aria-hidden="true"
                                                    className="ml-auto hidden size-3.5 shrink-0 text-ink-faint group-data-focus:block"
                                                />
                                            </ComboboxOption>
                                        ))}
                                    </Fragment>
                                ))}
                            </ComboboxOptions>
                        )}
                    </Combobox>
                </DialogPanel>
            </div>
        </Dialog>
    )
}

function rowKey(hit: SearchHit): string {
    switch (hit.kind) {
        case 'vulnerability':
            return hit.item.identity
        case 'package':
            return hit.item.name
        case 'image':
            return hit.item.id
        case 'container':
            return hit.item.containerId
        case 'cluster':
            return hit.item.id
    }
}

const ROW_ICON = 'size-4 shrink-0 text-ink-muted'

function RowContent({ row, term }: { row: Row; term: string }) {
    if (row.type === 'direct') {
        return (
            <>
                <ShieldAlert aria-hidden="true" className={ROW_ICON} />
                <span className="min-w-0 flex-1 truncate">
                    Open <span className="font-mono">{row.vulnId}</span>
                </span>
            </>
        )
    }
    if (row.type === 'fallback') {
        return (
            <>
                <Search aria-hidden="true" className={ROW_ICON} />
                <span className="min-w-0 flex-1 truncate text-ink-secondary">
                    Search {row.target} for “{term}”
                </span>
            </>
        )
    }

    const { hit } = row
    switch (hit.kind) {
        case 'vulnerability':
            return (
                <>
                    <ShieldAlert aria-hidden="true" className={ROW_ICON} />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono" title={hit.item.vulnId}>{hit.item.vulnId}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
                            <VulnerabilityBadge severity={hit.item.severity ?? 'unknown'} />
                            {hit.item.kev && <KevBadge />}
                            <span className="truncate">
                                {plural(hit.item.imageCount, 'image')} · {plural(hit.item.containerCount, 'container')}
                            </span>
                        </span>
                    </span>
                </>
            )
        case 'package':
            return (
                <>
                    {/* The ecosystem's own mark (npm, Maven, PyPI, …), a plain
                        parcel when there is none. */}
                    <PackageIcon purlType={hit.item.purlType} className={ROW_ICON} />
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                            <span className="truncate" title={hit.item.name}>{hit.item.name}</span>
                            {/* A tag, not a filter: the palette finds things by name, and a
                                base-image package is still the thing the reader typed. */}
                            {hit.item.base && (
                                <span
                                    className="shrink-0 rounded-full border border-edge px-1.5 text-xs text-ink-muted"
                                    title="Part of the base image: an operating-system package, or tooling that ships with the language"
                                >
                                    base
                                </span>
                            )}
                        </span>
                        <span className="block truncate text-xs text-ink-muted">
                            {[hit.item.purlType, plural(hit.item.versionCount, 'version'), plural(hit.item.imageCount, 'image')]
                                .filter(Boolean)
                                .join(' · ')}
                        </span>
                    </span>
                </>
            )
        case 'image':
            return (
                <>
                    <EntityIcon kind="image" className={ROW_ICON} />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs sm:text-sm" title={imageLabel(hit.item)}>{imageLabel(hit.item)}</span>
                        <span className="block truncate text-xs text-ink-muted">{hit.item.clusterName}</span>
                    </span>
                </>
            )
        case 'container':
            return (
                <>
                    <EntityIcon kind="container" className={ROW_ICON} />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate" title={hit.item.name}>{hit.item.name}</span>
                        <span className="block truncate text-xs text-ink-muted">
                            {[hit.item.kind, hit.item.namespace, hit.item.clusterName].filter(Boolean).join(' · ')}
                        </span>
                    </span>
                </>
            )
        case 'cluster':
            return (
                <>
                    <EntityIcon kind="cluster" className={ROW_ICON} />
                    <span className="min-w-0 flex-1 truncate">{hit.item.name}</span>
                </>
            )
    }
}

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, CircleDot } from 'lucide-react'
import { SiDocker } from 'react-icons/si'
import { Badge, KevBadge, SeverityDelta, VulnerabilityBadge } from '@/components/ui'
import { CLUSTER_COL, SeverityDeltaPair, TIME_COL } from './columns'
import { formatRiskChange } from '@/lib/risk'
import { severityBucket } from '@/lib/severity'
import type {
    ChangedFinding,
    ContainerEventPayload,
    ContainerSide,
    FeedEvent,
    FeedSlot,
    FindingsChangedPayload,
    RescoredFinding,
} from '@/types/feed'
import { formatShortDigest, isDigestLikeTag } from '@/utils/formatters'
import { EVENT_META, FEED_LABEL, scanLabel, scanSubject, slotLabel, subjectOf } from './eventMeta'
import {
    addedBySeverity,
    arrivedBySeverity,
    departedBySeverity,
    removedBySeverity,
    scoredTotal,
    type FeedLine,
} from './dayGroups'

/**
 * One feed row: a glance line — icon, subject, a couple of signed counters —
 * and, when the event carries more than the line can hold, an expansion with
 * the finding lists or the move's delta. Nothing here is a sentence: the
 * type's colour and the counters say what happened, the subject says to what.
 */

function timeOf(event: FeedEvent): string {
    return new Date(event.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function ImageLink({ imageId, children }: { imageId: string | null; children: React.ReactNode }) {
    if (!imageId) return <>{children}</>
    return (
        <Link href={`/images/${imageId}`} className="hover:text-accent hover:underline">
            {children}
        </Link>
    )
}

/** A one-piece subject that truncates as a flex item, linked to its image when there is one. */
function ImageSubject({ imageId, children }: { imageId: string | null; children: React.ReactNode }) {
    return (
        <span className="min-w-0 truncate text-ink">
            <ImageLink imageId={imageId}>{children}</ImageLink>
        </span>
    )
}

/* ---------- counters ---------- */

type Tone = 'critical' | 'high' | 'medium' | 'low' | 'success' | 'neutral'

const TONE_CLASS: Record<Tone, string> = {
    critical: 'bg-sev-critical-subtle text-sev-critical ring-sev-critical-muted',
    high: 'bg-sev-high-subtle text-sev-high ring-sev-high-muted',
    medium: 'bg-sev-medium-subtle text-sev-medium ring-sev-medium-muted',
    low: 'bg-sev-low-subtle text-sev-low ring-sev-low-muted',
    success: 'bg-success-subtle text-success ring-success-muted',
    neutral: 'bg-neutral-subtle text-neutral ring-neutral-muted',
}

/** `+3` / `−2` — a signed count, tinted by what it means. */
function Counter({ sign, count, tone, label, title }: { sign: '+' | '−'; count: number; tone: Tone; label?: string; title: string }) {
    if (count <= 0) return null
    return (
        <span
            title={title}
            aria-label={title}
            className={`inline-flex items-center gap-0.5 rounded-sm px-1.5 py-px text-xs font-semibold tabular-nums ring-1 ring-inset ${TONE_CLASS[tone]}`}
        >
            {sign}
            {count}
            {label && <span className="font-normal">{label}</span>}
        </span>
    )
}

/* ---------- the glance line, per type ---------- */

/** The tag if it is a real one, else the first 12 hex of the digest — the glance line has no room for `sha256:`. */
function shortRef(side: ContainerSide | null): string {
    if (!side) return '—'
    if (side.tag && !isDigestLikeTag(side.tag)) return side.tag
    return side.digest.replace(/^sha256:/, '').slice(0, 12)
}

/**
 * The glance line of a container event: the slot and the image it now runs
 * (or, for a stop, the one it ran); a move shows both sides, so a tag bump
 * reads as one. The repository, both full digests and the workload kind
 * wait in the expansion — the slot's own name already says which service
 * this is.
 */
function ContainerSubject({ event, p }: { event: FeedEvent; p: ContainerEventPayload }) {
    const oneSided = event.type === 'container.appeared' || event.type === 'container.removed'
    const side = event.type === 'container.removed' ? p.from : p.to
    return (
        <>
            <span className="truncate text-ink">{slotLabel(p)}</span>
            {oneSided && side && (
                <span className="shrink-0 text-ink-muted">
                    <ImageLink imageId={side.imageId}>{shortRef(side)}</ImageLink>
                </span>
            )}
            {!oneSided && p.from && p.to && (
                <span className="shrink-0 text-ink-muted">
                    <ImageLink imageId={p.from.imageId}>{shortRef(p.from)}</ImageLink>
                    <span className="text-ink-faint"> → </span>
                    <ImageLink imageId={p.to.imageId}>{shortRef(p.to)}</ImageLink>
                </span>
            )}
        </>
    )
}

/** The glance line of a scan event: the workload it hit, then how many more run the same image. */
function ScanSubject({ event, p }: { event: FeedEvent; p: FindingsChangedPayload }) {
    const { first, more } = scanSubject(p)
    return (
        <>
            <span className="truncate text-ink">
                <ImageLink imageId={event.imageId}>{first}</ImageLink>
            </span>
            {more > 0 && <span className="shrink-0 text-ink-muted">+{more} more</span>}
        </>
    )
}

function ContainerCounters({ p }: { p: ContainerEventPayload }) {
    const d = p.delta
    return (
        <>
            {p.mutableTag && p.to && <Badge variant="attention">tag moved</Badge>}
            {/* The move's answer to "did we gain or lose findings" is "neither" — say so, rather than show nothing. */}
            {d && d.resolved === 0 && d.introduced === 0 && <span className="text-xs text-ink-faint">no change</span>}
            {!d && p.deltaUnavailable && (
                <span className="text-xs text-ink-faint">
                    {p.deltaUnavailable === 'to-unscanned' ? 'not scanned yet' : 'previous image unscanned'}
                </span>
            )}
            {d && d.introducedKev > 0 && <KevBadge count={d.introducedKev} />}
            {d && d.introducedBySeverity && d.resolvedBySeverity ? (
                <SeverityDeltaPair
                    removed={d.resolvedBySeverity}
                    added={d.introducedBySeverity}
                    removedNoun="resolved by the move"
                    addedNoun="introduced by the move"
                />
            ) : d ? (
                /* A move recorded before the per-band counts existed: totals only. */
                <>
                    <Counter sign="−" count={d.resolved} tone="success" title={`${d.resolved} findings resolved by the move`} />
                    <Counter sign="+" count={d.introduced} tone="critical" title={`${d.introduced} findings introduced by the move`} />
                </>
            ) : null}
        </>
    )
}

function ScanCounters({ p }: { p: FindingsChangedPayload }) {
    const arrived = arrivedBySeverity(p)
    const departed = departedBySeverity(p)
    const kev = [...p.added, ...(p.rescored ?? [])].filter((f) => f.kevListed && isScored(f)).length
    return (
        <>
            {kev > 0 && <KevBadge count={kev} />}
            <SeverityDeltaPair removed={departed} added={arrived} removedNoun="resolved" addedNoun="new" />
        </>
    )
}

/** The feed shows scored findings only; an unscored advisory is not a change worth a line. */
function isScored(f: ChangedFinding): boolean {
    return severityBucket(f.severityLevel) !== 'unscored'
}

/* ---------- the expansion, per type ---------- */

/** `tag · sha256:abcdef…` with the image linked — one side of a move. */
function SideRef({ side }: { side: ContainerSide | null }) {
    if (!side) return <span className="text-ink-muted">—</span>
    const tag = side.tag && !isDigestLikeTag(side.tag) ? side.tag : null
    return (
        <ImageLink imageId={side.imageId}>
            <code className="text-ink">
                {tag && <>{tag} · </>}
                {formatShortDigest(side.digest)}
            </code>
        </ImageLink>
    )
}

function ContainerDetail({ event, p }: { event: FeedEvent; p: ContainerEventPayload }) {
    const d = p.delta
    const twoSided = Boolean(p.from && p.to)
    return (
        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-ink-muted">Where</dt>
            <dd className="text-ink-secondary">
                {event.clusterName && <>{event.clusterName} / </>}
                {p.namespace} / {p.workloadKind ? `${p.workloadKind} ` : ''}
                <code className="text-ink">{p.workloadName}</code> · container{' '}
                <code className="text-ink">{p.containerName}</code>
                {p.init && ' (init)'}
            </dd>
            <dt className="text-ink-muted">Image</dt>
            <dd className="text-ink-secondary">
                <code className="text-ink">{p.repository ?? 'unknown repository'}</code>
            </dd>
            {twoSided ? (
                <>
                    <dt className="text-ink-muted">From</dt>
                    <dd><SideRef side={p.from} /></dd>
                    <dt className="text-ink-muted">To</dt>
                    <dd><SideRef side={p.to} /></dd>
                </>
            ) : (
                <>
                    <dt className="text-ink-muted">{p.to ? 'Now' : 'Was'}</dt>
                    <dd><SideRef side={p.to ?? p.from} /></dd>
                </>
            )}
            {event.type === 'container.rollout-started' && (
                <>
                    <dt className="text-ink-muted">Status</dt>
                    <dd className="text-ink-secondary">
                        Both images are serving. The move is recorded when the old one stops.
                    </dd>
                </>
            )}
            {event.type === 'container.retagged' && (
                <>
                    <dt className="text-ink-muted">Status</dt>
                    <dd className="text-ink-secondary">The running bytes did not change — this is not a deploy.</dd>
                </>
            )}
            {d && (
                <>
                    <dt className="text-ink-muted">Delta</dt>
                    <dd className="text-ink-secondary">
                        resolves <strong className="text-success">{d.resolved}</strong>
                        {d.resolvedKev > 0 && <> ({d.resolvedKev} KEV)</>}, introduces{' '}
                        <strong className={d.introduced > 0 ? 'text-danger' : ''}>{d.introduced}</strong>
                        {d.introducedKev > 0 && <> ({d.introducedKev} KEV)</>}, {d.unchanged} unchanged ·{' '}
                        {formatRiskChange(d.riskChange)}
                    </dd>
                </>
            )}
            {p.deltaUnavailable && (
                <>
                    <dt className="text-ink-muted">Delta</dt>
                    <dd className="text-ink-muted">
                        {p.deltaUnavailable === 'to-unscanned'
                            ? 'the new image has not been scanned yet'
                            : 'the previous image was never scanned'}
                    </dd>
                </>
            )}
            {p.mutableTag && p.to && (
                <>
                    <dt className="text-ink-muted">Tag</dt>
                    <dd className="text-ink-secondary">
                        <code>{p.to.tag}</code> now resolves to a different image — a mutable tag was re-pulled.
                    </dd>
                </>
            )}
            {(p.imageNew || p.imageGone) && (
                <>
                    <dt className="text-ink-muted">Cluster</dt>
                    <dd className="flex flex-wrap gap-1.5">
                        {p.imageNew && p.to && <Badge variant="neutral">first time this image runs here</Badge>}
                        {p.imageGone && p.from && <Badge variant="muted">old image no longer runs here</Badge>}
                    </dd>
                </>
            )}
        </dl>
    )
}

function FindingRow({ finding }: { finding: ChangedFinding | RescoredFinding }) {
    const previous = 'previousSeverityLevel' in finding ? finding.previousSeverityLevel : undefined
    return (
        <li className="flex flex-wrap items-center gap-2 py-1 text-xs">
            {previous !== undefined && (
                <>
                    <VulnerabilityBadge severity={previous ?? 'unknown'} />
                    <span className="text-ink-faint">→</span>
                </>
            )}
            <VulnerabilityBadge severity={finding.severityLevel ?? 'unknown'} />
            {finding.kevListed && <KevBadge count={1} />}
            <code className="text-ink">{finding.vulnId}</code>
            <span className="text-ink-muted">
                in {finding.packageName}
                {finding.packageVersion ? `@${finding.packageVersion}` : ''}
            </span>
            {finding.fixedVersion && <span className="text-ink-muted">· fixed in {finding.fixedVersion}</span>}
        </li>
    )
}

/** How many findings an expansion shows before asking; the payload's head is at most 100. */
const PREVIEW = 8

const BAND_RANK: Record<ReturnType<typeof severityBucket>, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    unscored: 4,
}

/**
 * Severity first, then KEV, then risk. The server orders the head by risk
 * score, which is the right way to *choose* the hundred that ride in the
 * event, but a reader scanning a list expects the reds at the top.
 */
function bySeverity(a: ChangedFinding, b: ChangedFinding): number {
    const band = BAND_RANK[severityBucket(a.severityLevel)] - BAND_RANK[severityBucket(b.severityLevel)]
    if (band !== 0) return band
    if (a.kevListed !== b.kevListed) return a.kevListed ? -1 : 1
    return b.riskScore - a.riskScore
}

function FindingList<T extends ChangedFinding>({ title, count, findings }: { title: string; count: number; findings: T[] }) {
    const [all, setAll] = useState(false)
    if (findings.length === 0) return null
    const sorted = [...findings].sort(bySeverity)
    const shown = all ? sorted : sorted.slice(0, PREVIEW)
    const hidden = findings.length - shown.length
    return (
        <div>
            <p className="text-xs font-medium text-ink">
                {title} ({count})
                {count > findings.length && (
                    <span className="font-normal text-ink-muted"> · highest-risk {findings.length} carried</span>
                )}
            </p>
            <ul className="mt-1 divide-y divide-edge">
                {shown.map((f) => (
                    <FindingRow key={f.key} finding={f} />
                ))}
            </ul>
            {(hidden > 0 || all) && (
                <button
                    type="button"
                    onClick={() => setAll((v) => !v)}
                    className="mt-1 cursor-pointer text-xs text-accent hover:underline"
                >
                    {all ? 'Show fewer' : `Show ${hidden} more`}
                </button>
            )}
        </div>
    )
}

function ScanDetail({ event, p }: { event: FeedEvent; p: FindingsChangedPayload }) {
    const addedBands = addedBySeverity(p)
    const removedBands = removedBySeverity(p)
    const added = scoredTotal(addedBands)
    const removed = scoredTotal(removedBands)
    const unscoredOmitted = addedBands.unscored + removedBands.unscored
    /* A finding re-scored between two unscored levels is no change at all. */
    const rescored = (p.rescored ?? []).filter(
        (f) => isScored(f) || severityBucket(f.previousSeverityLevel) !== 'unscored'
    )
    const cause =
        p.cause === 'mirror'
            ? 'The advisory database changed against an image already running — nothing was deployed.'
            : p.cause === 'first-scan'
              ? 'The image was scanned for the first time; these findings came with it.'
              : 'The SBOM for this image was replaced and rescanned.'
    const slots: FeedSlot[] = p.containers ?? []
    const unnamed = (p.containerCount ?? slots.length) - slots.length
    return (
        <div className="space-y-3">
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                {slots.length > 0 && (
                    <>
                        <dt className="text-ink-muted">Containers</dt>
                        <dd className="text-ink-secondary">
                            <ul>
                                {slots.map((slot) => (
                                    <li key={`${slot.namespace}/${slot.workloadName}/${slot.containerName}`}>
                                        {slot.namespace} / {slot.workloadKind ? `${slot.workloadKind} ` : ''}
                                        <code className="text-ink">{slot.workloadName}</code> · container{' '}
                                        <code className="text-ink">{slot.containerName}</code>
                                        {slot.init && ' (init)'}
                                    </li>
                                ))}
                                {unnamed > 0 && <li className="text-ink-muted">and {unnamed} more</li>}
                            </ul>
                        </dd>
                    </>
                )}
                <dt className="text-ink-muted">Image</dt>
                <dd className="text-ink-secondary">
                    <ImageLink imageId={event.imageId}>
                        <code className="text-ink">
                            {p.repository ?? 'unknown repository'}
                            {p.digest && <> · {formatShortDigest(p.digest)}</>}
                        </code>
                    </ImageLink>
                    {event.clusterName && <> in {event.clusterName}</>}
                </dd>
                <dt className="text-ink-muted">Cause</dt>
                <dd className="text-ink-secondary">{cause}</dd>
                <dt className="text-ink-muted">Findings</dt>
                <dd className="text-ink-secondary">
                    <strong className={added > 0 ? 'text-danger' : ''}>{added}</strong> new,{' '}
                    <strong className={removed > 0 ? 'text-success' : ''}>{removed}</strong> resolved,{' '}
                    {rescored.length > 0 && <>{p.rescoredCount ?? rescored.length} re-scored, </>}
                    {p.unchangedCount} unchanged
                    {unscoredOmitted > 0 && (
                        <span className="text-ink-muted"> · {unscoredOmitted} unscored not shown</span>
                    )}
                </dd>
                <dt className="text-ink-muted">Risk</dt>
                <dd className="text-ink-secondary">
                    {Math.round(p.riskBefore)} → {Math.round(p.riskAfter)} ·{' '}
                    {formatRiskChange(Math.round((p.riskAfter - p.riskBefore) * 10) / 10)}
                </dd>
            </dl>
            <div className="grid gap-4 sm:grid-cols-2">
                <FindingList title="New" count={added} findings={p.added.filter(isScored)} />
                <FindingList title="Resolved" count={removed} findings={p.removed.filter(isScored)} />
                <FindingList title="Re-scored" count={p.rescoredCount ?? rescored.length} findings={rescored} />
            </div>
        </div>
    )
}

/* ---------- the row ---------- */

interface RowShape {
    subject: React.ReactNode
    /** The short verb, shown only when the counters don't already say it. */
    label: string | null
    counters: React.ReactNode
    detail: React.ReactNode
}

function shapeOf(event: FeedEvent): RowShape {
    const label = FEED_LABEL[event.type] ?? event.type

    if (event.type.startsWith('container.')) {
        const p = event.payload as unknown as ContainerEventPayload
        return {
            subject: <ContainerSubject event={event} p={p} />,
            label,
            counters: event.type === 'container.image-changed' ? <ContainerCounters p={p} /> : null,
            detail: <ContainerDetail event={event} p={p} />,
        }
    }

    if (event.type === 'scan.findings-changed') {
        const p = event.payload as unknown as FindingsChangedPayload
        return {
            subject: <ScanSubject event={event} p={p} />,
            label: scanLabel(p),
            counters: <ScanCounters p={p} />,
            detail: <ScanDetail event={event} p={p} />,
        }
    }

    if (event.type === 'scan.criticals-increased') {
        const p = event.payload as { repository?: string | null; criticalsBefore: number; criticalsAfter: number }
        return {
            subject: <ImageSubject imageId={event.imageId}>{p.repository ?? 'an image'}</ImageSubject>,
            label: null,
            counters: (
                <SeverityDelta
                    sign="+"
                    counts={{ critical: p.criticalsAfter - p.criticalsBefore, high: 0, medium: 0, low: 0 }}
                    noun="new"
                />
            ),
            detail: null,
        }
    }

    const reason = event.type === 'finding.suppressed' ? String(event.payload.reason ?? '') : ''
    return {
        subject: <ImageSubject imageId={event.imageId}>{subjectOf(event)}</ImageSubject>,
        label,
        counters: null,
        detail: reason ? <p className="text-xs text-ink-secondary">{reason}</p> : null,
    }
}

export function FeedEntry({ line, showCluster }: { line: FeedLine; showCluster: boolean }) {
    const { event, repeats } = line
    const [open, setOpen] = useState(false)
    const meta = EVENT_META[event.type] ?? { icon: CircleDot, toneClass: 'text-ink-muted' }
    /* Scan events are about an image, so they carry the image glyph the rest
       of the app uses (`EntityIcon`); the others keep their own verb icons. */
    const Icon = event.type.startsWith('scan.') ? SiDocker : meta.icon
    const { subject, label, counters, detail } = shapeOf(event)
    const expandable = detail !== null
    const Chevron = open ? ChevronDown : ChevronRight
    const detailId = `feed-detail-${event.id}`

    return (
        <li className="group rounded-sm hover:bg-surface-hover">
            {/* Wraps on a phone: the subject keeps the first line and the counters — a
                block of up to eight squares — drop under it rather than squeezing the
                subject to a few characters. From `sm` the row is one line. */}
            <div className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5 sm:flex-nowrap">
                {/* The disclosure leads the row, like a tree; rows with nothing to open keep the slot so icons align. */}
                {expandable ? (
                    <button
                        type="button"
                        onClick={() => setOpen((v) => !v)}
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={open ? 'Hide details' : 'Show details'}
                        className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-ink-faint hover:text-ink group-hover:text-ink-muted"
                    >
                        <Chevron aria-hidden className="size-3.5" />
                    </button>
                ) : (
                    <span aria-hidden className="size-4 shrink-0" />
                )}
                <Icon aria-hidden className={`size-4 shrink-0 ${meta.toneClass}`} />
                <p className="flex min-w-0 items-baseline gap-x-2 font-mono text-[13px]">
                    {subject}
                    {label && <span className="shrink-0 font-sans text-xs text-ink-muted">{label}</span>}
                </p>
                {repeats.length > 1 && (
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted" title={`${repeats.length} identical changes today`}>
                        ×{repeats.length}
                    </span>
                )}
                <span className="flex-1" />
                {/* The counters are a right-aligned column: the trailing cluster and time columns are
                    fixed-width, so every row's squares end on the same edge. */}
                {counters && (
                    <span
                        onClick={expandable ? () => setOpen((v) => !v) : undefined}
                        className={`ml-auto flex shrink-0 items-center justify-end gap-1.5 ${expandable ? 'cursor-pointer' : ''}`}
                    >
                        {counters}
                    </span>
                )}
                {showCluster && (
                    <span className={`${CLUSTER_COL} truncate text-xs text-ink-muted`}>{event.clusterName ?? ''}</span>
                )}
                <span className={`${TIME_COL} text-right text-xs tabular-nums text-ink-faint`}>{timeOf(event)}</span>
            </div>
            {open && detail && (
                <div id={detailId} className="ml-6 mr-2 mb-2 border-l border-edge pl-3 pb-1 sm:ml-14">
                    {detail}
                </div>
            )}
        </li>
    )
}

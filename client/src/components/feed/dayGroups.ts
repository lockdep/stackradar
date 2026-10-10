import type {
    ChangedFinding,
    ContainerEventPayload,
    FeedEvent,
    FindingsChangedPayload,
    SeverityBreakdown,
} from '@/types/feed'
import { severityBucket } from '@/lib/severity'

/**
 * Read-time shaping of the flat page the server returns —
 * docs/proposals/activity-feed.md §7 and §8. Day blocks are the viewer's
 * calendar days; repeats of one slot event inside a day fold into one line
 * with a count. The server stores neither: grouping is a read-time choice,
 * like the workloads list grouping by namespace.
 *
 * The page answers four questions about the workloads the org tracks: did
 * one start or stop being tracked, did one change image, what did that do
 * to its findings, and did the advisory database change against one. Three
 * things the log records are not answers and are dropped here: a first scan
 * (the image's findings are inventory — the move that brought it carries
 * the delta), a scan that only touched unscored findings, and a rollout
 * whose completing move is also in the page.
 */

/** One feed line: an event, plus how many identical ones it stands for. */
export interface FeedLine {
    event: FeedEvent
    /** The events folded into this line, newest first. `[0]` is `event`. */
    repeats: FeedEvent[]
}

export const EMPTY_BREAKDOWN: SeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, unscored: 0 }

function countHead<T extends ChangedFinding>(
    findings: T[],
    level: (f: T) => string | null = (f) => f.severityLevel
): SeverityBreakdown {
    const out = { ...EMPTY_BREAKDOWN }
    for (const f of findings) out[severityBucket(level(f))] += 1
    return out
}

function addInto(target: SeverityBreakdown, more: SeverityBreakdown) {
    target.critical += more.critical
    target.high += more.high
    target.medium += more.medium
    target.low += more.low
    target.unscored += more.unscored
}

/** The scored bands only. The feed does not count unscored findings — see `isSilentScan`. */
export function scoredTotal(b: SeverityBreakdown): number {
    return b.critical + b.high + b.medium + b.low
}

/**
 * The per-band counts of a scan event. The server writes them exactly; an
 * event from before it did is counted from the head list it carries, which
 * is exact up to a hundred findings and an undercount past that.
 */
export function addedBySeverity(p: FindingsChangedPayload): SeverityBreakdown {
    return p.addedBySeverity ?? countHead(p.added)
}

export function removedBySeverity(p: FindingsChangedPayload): SeverityBreakdown {
    return p.removedBySeverity ?? countHead(p.removed)
}

/**
 * What *entered* each scored band in this scan: findings that arrived, plus
 * findings already there whose advisory was re-scored into the band. To the
 * reader an advisory that went from unscored to critical is a new critical,
 * and the feed hides unscored findings, so this is the first they see of it.
 * `unscored` is always zero here.
 */
export function arrivedBySeverity(p: FindingsChangedPayload): SeverityBreakdown {
    const out = { ...addedBySeverity(p), unscored: 0 }
    addInto(out, p.rescoredToBySeverity ?? countHead(p.rescored ?? []))
    out.unscored = 0
    return out
}

/** What *left* each scored band: resolved findings, plus re-scored ones by the band they left. */
export function departedBySeverity(p: FindingsChangedPayload): SeverityBreakdown {
    const out = { ...removedBySeverity(p), unscored: 0 }
    addInto(out, p.rescoredFromBySeverity ?? countHead(p.rescored ?? [], (f) => f.previousSeverityLevel))
    out.unscored = 0
    return out
}

/** A scan that only touched unscored findings is not a change the feed shows. */
export function isSilentScan(p: FindingsChangedPayload): boolean {
    return scoredTotal(arrivedBySeverity(p)) === 0 && scoredTotal(departedBySeverity(p)) === 0
}

/**
 * The image's first scan: nothing before, so everything "arrived". The
 * server says so since `first-scan` existed — and, since the same change,
 * always names the running slots. An event from before then is recognised
 * by its shape: a scan that removed, kept and re-scored nothing. (Once the
 * server says the cause, the shape is not consulted: a distroless image
 * gaining its first advisory looks the same and is a real change.)
 */
export function isFirstScan(p: FindingsChangedPayload): boolean {
    if (p.cause === 'first-scan') return true
    if (p.containers !== undefined) return false
    return !p.replaced && p.removedCount === 0 && p.unchangedCount === 0 && !(p.rescoredCount ?? 0)
}

/**
 * Job and CronJob pods come and go by design — each run is a new slot name —
 * so their starting and stopping is not a workload being tracked or dropped.
 * The server already elides most of it (§8); what reaches the page is the
 * run whose image was new to the cluster or is gone from it, which is still
 * not the question. A scheduled workload's *image change* is never hidden.
 */
const SCHEDULED_KINDS = new Set(['cronjob', 'job'])

function isScheduledChurn(event: FeedEvent): boolean {
    if (event.type !== 'container.appeared' && event.type !== 'container.removed') return false
    const p = event.payload as unknown as ContainerEventPayload
    return SCHEDULED_KINDS.has((p.workloadKind ?? '').toLowerCase())
}

/** A slot on a digest: what `appeared` and `removed` pair up on. */
function slotDigestKey(event: FeedEvent): string {
    const p = event.payload as unknown as ContainerEventPayload
    const side = event.type === 'container.removed' ? p.from : p.to
    return [event.clusterId, p.namespace, p.workloadName, p.containerName, side?.digest ?? ''].join('|')
}

/**
 * A slot that stopped and started again on the same digest within a day did
 * not change what is tracked: an informer hiccup or a restart. Fold the pair
 * to its net effect — nothing when the counts match, else only the newest.
 */
function netTracking(events: FeedEvent[]): FeedEvent[] {
    const tally = new Map<string, { appeared: number; removed: number }>()
    for (const event of events) {
        if (event.type !== 'container.appeared' && event.type !== 'container.removed') continue
        const key = slotDigestKey(event)
        const t = tally.get(key) ?? { appeared: 0, removed: 0 }
        if (event.type === 'container.appeared') t.appeared += 1
        else t.removed += 1
        tally.set(key, t)
    }
    const kept = new Set<string>()
    return events.filter((event) => {
        if (event.type !== 'container.appeared' && event.type !== 'container.removed') return true
        const key = slotDigestKey(event)
        const t = tally.get(key)!
        if (t.appeared === t.removed) return false
        if (kept.has(key)) return false
        kept.add(key) // newest first, so the first one seen is the net effect
        return true
    })
}

/** A rollout and the move that completes it share this key. */
function rolloutKey(event: FeedEvent): string {
    const p = event.payload as unknown as ContainerEventPayload
    return [event.clusterId, p.namespace, p.workloadName, p.containerName, p.from?.digest ?? '', p.to?.digest ?? ''].join('|')
}

/** The events the page shows, in the order given. */
export function feedWorthy(events: FeedEvent[]): FeedEvent[] {
    const completed = new Set(
        events.filter((e) => e.type === 'container.image-changed').map(rolloutKey)
    )
    return events.filter((event) => {
        if (event.type === 'scan.findings-changed') {
            const p = event.payload as unknown as FindingsChangedPayload
            return !isFirstScan(p) && !isSilentScan(p)
        }
        if (event.type === 'container.rollout-started') return !completed.has(rolloutKey(event))
        return !isScheduledChurn(event)
    })
}

export interface DaySummary {
    /** Findings the tracked workloads gained and lost — from moves and from advisory changes alike. */
    findingsAdded: number
    findingsResolved: number
    findingsAddedBySeverity: SeverityBreakdown
    findingsResolvedBySeverity: SeverityBreakdown
    /** Containers that changed image. */
    containersMoved: number
    /** Rollouts still in progress — both digests serving. */
    rolloutsInProgress: number
    /** Containers that started and stopped being tracked. */
    containersTracked: number
    containersUntracked: number
}

export interface DayGroup {
    /** `YYYY-MM-DD` in the viewer's timezone — the React key and the heading's source. */
    key: string
    date: Date
    lines: FeedLine[]
    summary: DaySummary
}

function localDayKey(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/**
 * The fold key. Container events fold on the slot and the digests on both
 * sides — a CronJob's pod on the same image appearing five times in a day
 * is one line, `×5`; a slot that moved A→B and then B→C is two. Scan and
 * issue events fold on the image or issue they are about.
 */
function foldKey(event: FeedEvent): string {
    if (event.type.startsWith('container.')) {
        const p = event.payload as unknown as ContainerEventPayload
        return [
            event.type,
            event.clusterId,
            p.namespace,
            p.workloadName,
            p.containerName,
            p.from?.digest ?? '',
            p.to?.digest ?? '',
            p.from?.tag ?? '',
            p.to?.tag ?? '',
        ].join('|')
    }
    // Everything else is already one-per-change; a repeat is a distinct change.
    return event.id
}

function summarise(events: FeedEvent[]): DaySummary {
    const summary: DaySummary = {
        findingsAdded: 0,
        findingsResolved: 0,
        findingsAddedBySeverity: { ...EMPTY_BREAKDOWN },
        findingsResolvedBySeverity: { ...EMPTY_BREAKDOWN },
        containersMoved: 0,
        rolloutsInProgress: 0,
        containersTracked: 0,
        containersUntracked: 0,
    }
    for (const event of events) {
        switch (event.type) {
            case 'scan.findings-changed': {
                const p = event.payload as unknown as FindingsChangedPayload
                const arrived = arrivedBySeverity(p)
                const departed = departedBySeverity(p)
                summary.findingsAdded += scoredTotal(arrived)
                summary.findingsResolved += scoredTotal(departed)
                addInto(summary.findingsAddedBySeverity, arrived)
                addInto(summary.findingsResolvedBySeverity, departed)
                break
            }
            case 'container.image-changed': {
                const p = event.payload as unknown as ContainerEventPayload
                summary.containersMoved += 1
                const d = p.delta
                if (d) {
                    summary.findingsAdded += d.introducedBySeverity ? scoredTotal(d.introducedBySeverity) : d.introduced
                    summary.findingsResolved += d.resolvedBySeverity ? scoredTotal(d.resolvedBySeverity) : d.resolved
                    if (d.introducedBySeverity) addInto(summary.findingsAddedBySeverity, { ...d.introducedBySeverity, unscored: 0 })
                    if (d.resolvedBySeverity) addInto(summary.findingsResolvedBySeverity, { ...d.resolvedBySeverity, unscored: 0 })
                }
                break
            }
            case 'container.rollout-started':
                summary.rolloutsInProgress += 1
                break
            case 'container.appeared':
                summary.containersTracked += 1
                break
            case 'container.removed':
                summary.containersUntracked += 1
                break
            default:
                break
        }
    }
    return summary
}

/** Events newest first in, day groups newest first out. */
export function groupByDay(events: FeedEvent[]): DayGroup[] {
    const groups = new Map<string, { date: Date; events: FeedEvent[] }>()
    for (const event of feedWorthy(events)) {
        const date = new Date(event.createdAt)
        const key = localDayKey(date)
        let group = groups.get(key)
        if (!group) groups.set(key, (group = { date, events: [] }))
        group.events.push(event)
    }

    return [...groups.entries()].map(([key, { date, events: rawEvents }]) => {
        const dayEvents = netTracking(rawEvents)
        const lines = new Map<string, FeedLine>()
        for (const event of dayEvents) {
            const fold = foldKey(event)
            const line = lines.get(fold)
            if (line) line.repeats.push(event)
            else lines.set(fold, { event, repeats: [event] })
        }
        return { key, date, lines: [...lines.values()], summary: summarise(dayEvents) }
    })
}

/** "Today", "Yesterday", else a weekday and date in the viewer's locale. */
export function dayHeading(date: Date, now = new Date()): string {
    const today = localDayKey(now)
    const key = localDayKey(date)
    if (key === today) return 'Today'
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (key === localDayKey(yesterday)) return 'Yesterday'
    const sameYear = date.getFullYear() === now.getFullYear()
    return date.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
    })
}

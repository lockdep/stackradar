import {
    ArrowRightLeft,
    BellRing,
    CheckCircle2,
    CircleDot,
    Clock,
    Eye,
    EyeOff,
    GitBranch,
    ListPlus,
    PackageMinus,
    PackagePlus,
    RotateCcw,
    Tag,
    TrendingUp,
    Wrench,
    XCircle,
} from 'lucide-react'
import type {
    ActivityEvent,
    ActivityEventType,
    ContainerEventPayload,
    FindingsChangedPayload,
} from '@/types/feed'
import { formatShortDigest, isDigestLikeTag } from '@/utils/formatters'

/**
 * Per-type copy for the Feed page. One
 * table, so an event type added on the server is added here once — both
 * `Record`s are total over `ActivityEventType`, and the compiler says so.
 */

export const EVENT_META: Record<ActivityEventType, { icon: typeof CircleDot; toneClass: string }> = {
    'issue.created': { icon: CircleDot, toneClass: 'text-accent' },
    'issue.snoozed': { icon: Clock, toneClass: 'text-ink-muted' },
    'issue.applied': { icon: BellRing, toneClass: 'text-attention' },
    'issue.reopened': { icon: RotateCcw, toneClass: 'text-ink-muted' },
    'issue.verified': { icon: CheckCircle2, toneClass: 'text-success' },
    'issue.closed': { icon: XCircle, toneClass: 'text-ink-muted' },
    'issue.fix-available': { icon: Wrench, toneClass: 'text-success' },
    'finding.suppressed': { icon: EyeOff, toneClass: 'text-ink-muted' },
    'finding.unsuppressed': { icon: Eye, toneClass: 'text-ink-muted' },
    'scan.criticals-increased': { icon: TrendingUp, toneClass: 'text-danger' },
    'container.appeared': { icon: PackagePlus, toneClass: 'text-accent' },
    'container.removed': { icon: PackageMinus, toneClass: 'text-ink-muted' },
    'container.image-changed': { icon: ArrowRightLeft, toneClass: 'text-accent' },
    'container.rollout-started': { icon: GitBranch, toneClass: 'text-attention' },
    'container.retagged': { icon: Tag, toneClass: 'text-ink-muted' },
    'scan.findings-changed': { icon: ListPlus, toneClass: 'text-danger' },
}

/**
 * The Feed page's short verb — a word or two after the subject, never a
 * sentence. The scan types have none: their counters say it.
 */
export const FEED_LABEL: Record<ActivityEventType, string | null> = {
    'issue.created': 'issue opened',
    'issue.snoozed': 'issue snoozed',
    'issue.applied': 'issue applied',
    'issue.reopened': 'issue reopened',
    'issue.verified': 'issue verified',
    'issue.closed': 'issue closed',
    'issue.fix-available': 'fix available',
    'finding.suppressed': 'suppressed',
    'finding.unsuppressed': 'suppression lifted',
    'scan.criticals-increased': null,
    'container.appeared': 'now tracked',
    'container.removed': 'no longer tracked',
    'container.image-changed': 'image changed',
    'container.rollout-started': 'rolling out',
    'container.retagged': 'retagged',
    'scan.findings-changed': null,
}

/** The scan line's verb turns on its cause; a first scan never reaches the page. */
export function scanLabel(p: FindingsChangedPayload): string {
    return p.cause === 'mirror' ? 'advisories changed' : 'SBOM replaced'
}

/** The workloads a scan event names: `prod/web · api`, then how many more. */
export function scanSubject(p: FindingsChangedPayload): { first: string; more: number } {
    const slots = p.containers ?? []
    if (slots.length === 0) return { first: p.repository ?? 'an image', more: 0 }
    const total = p.containerCount ?? slots.length
    return { first: slotLabel(slots[0]!), more: Math.max(0, total - 1) }
}

/** A tag if there is one, else the short digest — never a 64-hex "tag". */
export function tagOrDigest(side: { tag: string | null; digest: string } | null): string {
    if (!side) return '—'
    if (side.tag && !isDigestLikeTag(side.tag)) return side.tag
    return formatShortDigest(side.digest) ?? side.digest
}

/** The container event's slot, as a path: `prod/web · api`. */
export function slotLabel(p: Pick<ContainerEventPayload, 'namespace' | 'workloadName' | 'containerName'>): string {
    return `${p.namespace}/${p.workloadName} · ${p.containerName}`
}

export function subjectOf(event: ActivityEvent): string {
    const p = event.payload as Record<string, string | number | null | undefined>
    if (event.type.startsWith('container.')) {
        const c = event.payload as unknown as ContainerEventPayload
        const repo = c.repository ?? 'image'
        switch (event.type) {
            case 'container.appeared':
                return `${slotLabel(c)} — ${repo}:${tagOrDigest(c.to)}`
            case 'container.removed':
                return `${slotLabel(c)} — ${repo}:${tagOrDigest(c.from)}`
            default:
                return `${slotLabel(c)} — ${repo} ${tagOrDigest(c.from)} → ${tagOrDigest(c.to)}`
        }
    }
    if (event.type === 'scan.findings-changed') {
        const f = event.payload as unknown as FindingsChangedPayload
        const parts: string[] = []
        if (f.addedCount > 0) parts.push(`${f.addedCount} new`)
        if (f.removedCount > 0) parts.push(`${f.removedCount} resolved`)
        return `${f.repository ?? 'an image'}: ${parts.join(', ')}`
    }
    if (event.type === 'scan.criticals-increased') {
        return `${p.repository ?? 'an image'}: criticals ${p.criticalsBefore} → ${p.criticalsAfter}`
    }
    if (event.type.startsWith('finding.') || p.scope === 'finding') {
        return `${p.vulnId} in ${p.packageName}`
    }
    if (p.scope === 'release') {
        return `${p.chartName} ${p.fromChartVersion ?? ''}${p.toChartVersion ? ` → ${p.toChartVersion}` : ''}`
    }
    return `${p.repository ?? 'image'}${p.fromTag ? `:${p.fromTag}` : ''}${p.toTag ? ` → ${p.toTag}` : ''}`
}

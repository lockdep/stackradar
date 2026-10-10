/* The admin tabs read these from here; the definitions live with the app's
   other formatters so the two sides cannot drift. */
export { formatTimeAgo, formatDuration } from '@/utils/formatters'

export function formatNumber(n: number): string {
    return n.toLocaleString()
}

/**
 * A span in seconds, as a span — not as a point in time. Distinct from
 * formatTimeAgo, which answers "when"; this answers "how far behind".
 */
export function formatLag(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ${minutes % 60}m`
    return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * How far the mirror is behind what OSV has published: the gap between the two
 * watermarks, in seconds.
 *
 * Null unless both exist — a mirror that has never applied anything has no lag,
 * and reporting 0 for it would read as perfectly fresh. Mirrors the same rule
 * in the server's SyncStateManager.getLagSeconds().
 */
export function computeLagSeconds(seen: string | null, applied: string | null): number | null {
    if (!seen || !applied) return null
    const gap = new Date(seen).getTime() - new Date(applied).getTime()
    return Math.max(0, Math.floor(gap / 1000))
}

/**
 * A tone for a figure that is only interesting once it gets large — lag, queue
 * age, a failure rate. `null` means there is nothing to judge (no lag to
 * measure, no job waiting), which is not the same as zero and must not be drawn
 * as either good or bad.
 */
export type HealthTone = 'neutral' | 'good' | 'warn' | 'bad'

export function thresholdTone(value: number | null, warnAt: number, badAt: number): HealthTone {
    if (value === null) return 'neutral'
    if (value >= badAt) return 'bad'
    if (value >= warnAt) return 'warn'
    return 'good'
}

/**
 * Mirror lag thresholds, shared by the Overview tile and the OSV tab so the two
 * can never disagree about what "behind" means.
 *
 * The warning step is OSV_LAG_WARNING_THRESHOLD_HOURS (`osv-sync/config.ts`),
 * which is also what the OsvMirrorLagHigh alert fires on. The critical step is a
 * day: past that the mirror has missed a full incremental cycle several times
 * over and the gap is no longer explainable by a slow poll.
 */
export const OSV_LAG_WARNING_SECONDS = 6 * 3600
export const OSV_LAG_CRITICAL_SECONDS = 24 * 3600

/**
 * How long a job may sit `pending` before it is worth looking at.
 *
 * The worker polls every few seconds, so anything past a few minutes means it is
 * not claiming — not that it is busy. Fifteen minutes is generous enough to
 * absorb a long-running batch ahead of the queue; an hour is not survivable.
 */
export const JOB_PENDING_WARNING_SECONDS = 15 * 60
export const JOB_PENDING_CRITICAL_SECONDS = 60 * 60

/**
 * Mirror of `server/src/config/plans.ts` for the admin org table. SBOMs are
 * uncapped on every tier (completeness of the current picture is never
 * charged for), so that column renders usage against ∞.
 */
const ADMIN_PLAN_LIMITS = {
    free: { members: 1, clusters: 1, sboms: Infinity },
    pro: { members: 10, clusters: 5, sboms: Infinity },
    team: { members: 25, clusters: 15, sboms: Infinity },
} as const

export function getAdminPlanLimits(plan: string) {
    return ADMIN_PLAN_LIMITS[plan as keyof typeof ADMIN_PLAN_LIMITS] ?? ADMIN_PLAN_LIMITS.free
}

export function formatMax(n: number): string {
    return n === Infinity ? '∞' : formatNumber(n)
}

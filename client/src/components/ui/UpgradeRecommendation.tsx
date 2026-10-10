'use client'

import { ArrowRight, CircleAlert, CircleHelp, Info } from 'lucide-react'
import { Badge } from './Badge'
import { KevBadge, RiskChip, TotalRiskChip } from './RiskScore'
import { formatRiskChange } from '@/lib/risk'
import type { SeverityBreakdown } from '@/types/feed'

/**
 * "Move to `node:20.18-slim` — clears 23 findings, 4 of them high, 1 on KEV.
 *  2 findings remain and need an application-level fix."
 *
 * The runtime equivalent of an auto-fix: we never see the repository, but we do
 * know what is running, so we can say what to run instead.
 *
 * Three rules this component exists to enforce, all of them about what *not*
 * to say:
 *
 *  - **Never imply safety.** It is a version bump; it can break things. The
 *    copy says what it clears and what it leaves, and nothing about whether it
 *    is safe to deploy. There is no "apply" button and there will not be one.
 *  - **Never hide a refusal.** "We found three tags and could not tell you
 *    whether they are newer" is a real answer, and rendering it as silence
 *    reads as "you are up to date".
 *  - **Never conflate "no newer version" with "not measured".** A newer chart
 *    we have not scanned is a third state, and it is the honest one.
 */

type IncomparableReason =
    | 'not-a-version'
    | 'different-variant'
    | 'different-precision'
    | 'prerelease'

/** Why a candidate was refused, in the user's terms rather than the parser's. */
const REFUSAL_COPY: Record<IncomparableReason, string> = {
    'different-variant':
        'a different base image variant — moving to it would change the distribution under your application',
    'different-precision':
        'a less specific tag — it already points at whatever the newest patch is, so there is nothing to move to',
    'not-a-version': 'not a version number, so it cannot be ordered against yours',
    prerelease: 'a pre-release',
}

export interface DeltaSummary {
    resolved: number
    introduced: number
    unchanged: number
    resolvedKev: number
    introducedKev: number
    resolvedHigh: number
    /** Per-band counts. Optional only because container events written before they existed lack them. */
    resolvedBySeverity?: SeverityBreakdown
    introducedBySeverity?: SeverityBreakdown
    riskBefore: number
    riskAfter: number
    riskChange: number
}

interface TagCandidate {
    tag: string
    imageId: string
    digest: string
    bump: 'major' | 'minor' | 'patch' | 'none'
    summary: DeltaSummary
}

export interface ImageUpgrade {
    availability:
        | 'available'
        | 'up-to-date'
        | 'no-candidates'
        | 'not-measured'
        | 'ambiguous-ordering'
    current: { imageId: string; digest: string; repository: string | null; tag: string | null }
    best: TagCandidate | null
    candidates: TagCandidate[]
    skipped: Array<{ tag: string; reason: IncomparableReason }>
    remaining: Array<{
        vulnId: string
        packageName: string
        severityLevel: string | null
        riskScore: number
        kevListed: boolean
        fixedVersion: string | null
    }>
}

function Panel({ children }: { children: React.ReactNode }) {
    return (
        <section className="rounded-lg border border-edge bg-surface-muted p-4">{children}</section>
    )
}

function Quiet({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <Panel>
            <p className="flex items-start gap-2 text-sm text-ink-muted">
                <span className="mt-px shrink-0">{icon}</span>
                <span>{children}</span>
            </p>
        </Panel>
    )
}

export function ImageUpgradePanel({ upgrade }: { upgrade: ImageUpgrade }) {
    const { availability, current, best, skipped } = upgrade

    if (availability === 'ambiguous-ordering' || (skipped.length > 0 && !best)) {
        return (
            <Quiet icon={<CircleHelp aria-hidden="true" className="size-4" />}>
                <span className="text-ink">Other tags exist, but none we can safely compare.</span>{' '}
                We only compare tags of the same variant and the same precision, so we do not
                recommend a move that changes what your application runs on.
                <ul className="mt-2 space-y-1">
                    {skipped.map(s => (
                        <li key={s.tag}>
                            <code className="text-ink">{s.tag}</code> — {REFUSAL_COPY[s.reason]}
                        </li>
                    ))}
                </ul>
            </Quiet>
        )
    }

    if (availability === 'up-to-date') {
        return (
            <Quiet icon={<Info aria-hidden="true" className="size-4" />}>
                <code className="text-ink">{current.tag}</code> is the newest tag of this
                repository that anyone in your organisation has scanned. That is not the same as
                the newest tag that exists.
            </Quiet>
        )
    }

    if (!best) {
        return (
            <Quiet icon={<Info aria-hidden="true" className="size-4" />}>
                {current.tag
                    ? 'No other scanned tag of this repository to compare against.'
                    : 'This deployment is pinned to a digest, so there is no tag to compare from.'}
            </Quiet>
        )
    }

    const { summary } = best
    const worse = summary.riskChange > 0

    return (
        <Panel>
            <header className="flex flex-wrap items-center gap-2">
                <code className="break-all text-sm text-ink-muted">{current.tag}</code>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                <code className="break-all text-sm font-semibold text-ink">{best.tag}</code>
                <Badge variant={best.bump === 'major' ? 'attention' : 'neutral'}>
                    {best.bump} bump
                </Badge>
            </header>

            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink">
                {/* Totals, not finding scores — before/after are the image's
                    summed risk, so the delta between the chips is exactly the
                    risk the bump removes. */}
                <TotalRiskChip score={summary.riskBefore} />
                <ArrowRight aria-hidden="true" className="size-3.5 text-ink-muted" />
                <TotalRiskChip score={summary.riskAfter} />
                <span className={worse ? 'text-danger' : 'text-ink-muted'}>
                    {formatRiskChange(summary.riskChange)}
                </span>
            </p>

            <p className="mt-2 text-sm text-ink">
                Clears <strong>{summary.resolved}</strong> finding
                {summary.resolved === 1 ? '' : 's'}
                {summary.resolvedHigh > 0 && <>, {summary.resolvedHigh} of them high or critical</>}
                {summary.resolvedKev > 0 && (
                    <>
                        , <KevBadge count={summary.resolvedKev} />
                    </>
                )}
                .
                {summary.introduced > 0 && (
                    <>
                        {' '}
                        Introduces <strong>{summary.introduced}</strong> new finding
                        {summary.introduced === 1 ? '' : 's'}
                        {summary.introducedKev > 0 && ', one of them on KEV'}.
                    </>
                )}
            </p>

            {/* The honest half. A recommendation that reports only what it
                clears is a sales pitch — the point of listing what survives is
                that the customer knows the bump is not the whole fix. */}
            {upgrade.remaining.length > 0 && (
                <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-ink-muted hover:text-ink">
                        {upgrade.remaining.length} finding
                        {upgrade.remaining.length === 1 ? '' : 's'} this bump does not fix
                    </summary>
                    <ul className="mt-2 space-y-1 text-[13px]">
                        {upgrade.remaining.slice(0, 10).map(f => (
                            <li key={`${f.packageName}-${f.vulnId}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <RiskChip score={f.riskScore} />
                                <code className="text-ink">{f.vulnId}</code>
                                <span className="text-ink-muted">in {f.packageName}</span>
                                {f.kevListed && <KevBadge />}
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            {skipped.length > 0 && (
                <p className="mt-3 text-[11px] text-ink-muted">
                    {skipped.length} other tag{skipped.length === 1 ? '' : 's'} of this repository
                    were not compared — different variant or precision.
                </p>
            )}

            {/* No "apply". We do not have the repository and we are not going
                to imply this is risk-free. */}
            <p className="mt-3 text-[11px] text-ink-muted">
                A version bump can break things. This says what it clears and what it leaves; it
                says nothing about whether it is safe to deploy.
            </p>
        </Panel>
    )
}

export interface ChartUpgrade {
    availability: ImageUpgrade['availability']
    release: {
        chartName: string | null
        chartVersion: string | null
        appVersion: string | null
        repoUrl: string | null
        attributedRepoUrl: string | null
    }
    /** Platform-render targets run in no release: cluster and namespace are null. */
    target: { chartVersion: string; cluster: string | null; namespace: string | null } | null
    /** What backs a measured delta. Absent unless availability is `available`. */
    evidence: 'sibling-release' | 'platform-render' | null
    matchKind: 'repo-url' | 'attributed' | 'chart-name' | null
    bump: 'major' | 'minor' | 'patch' | 'none'
    imageMoves: Array<{
        repository: string | null
        fromDigest: string
        toDigest: string
        summary: DeltaSummary
    }>
    unmeasuredImages: number
    delivery: { tool: string; appName: string; targetRevision: string | null } | null
    /** Artifact Hub lists a newer version, but no sibling runs it. Unmeasured. */
    mirrorNewer: { version: string; kube: string | null } | null
    /** The suggested version's kubeVersion range excludes this cluster. */
    kubeWarning: { clusterVersion: string; kubeRange: string } | null
}

export function ChartUpgradePanel({ upgrade }: { upgrade: ChartUpgrade }) {
    const { availability, release, target, matchKind, imageMoves, delivery } = upgrade

    if (availability === 'not-measured' && target) {
        return (
            <Quiet icon={<CircleHelp aria-hidden="true" className="size-4" />}>
                <span className="text-ink">
                    Chart {release.chartName} {target.chartVersion} exists, but nothing has scanned
                    the images it deploys.
                </span>{' '}
                We can see the newer version; we cannot tell you what moving to it would clear.
                This is not the same as saying there is nothing to fix.
            </Quiet>
        )
    }

    if (!target || imageMoves.length === 0) {
        return (
            <Quiet icon={<Info aria-hidden="true" className="size-4" />}>
                No other release of {release.chartName ?? 'this chart'} in your organisation runs a
                newer version.
                {/* The mirror's listing is weaker than a sibling: nobody here
                    runs it, nothing has scanned it — and the copy says so. */}
                {upgrade.mirrorNewer && (
                    <>
                        {' '}
                        Artifact Hub lists {release.chartName}{' '}
                        <code className="text-ink">{upgrade.mirrorNewer.version}</code>; nothing has
                        scanned what it deploys.
                        {upgrade.kubeWarning && (
                            <span className="text-attention">
                                {' '}
                                It requires Kubernetes <code>
                                    {upgrade.kubeWarning.kubeRange}
                                </code>; this cluster reports{' '}
                                <code>{upgrade.kubeWarning.clusterVersion}</code>.
                            </span>
                        )}
                    </>
                )}
            </Quiet>
        )
    }

    const totals = imageMoves.reduce(
        (acc, m) => ({
            resolved: acc.resolved + m.summary.resolved,
            introduced: acc.introduced + m.summary.introduced,
            kev: acc.kev + m.summary.resolvedKev,
        }),
        { resolved: 0, introduced: 0, kev: 0 }
    )

    return (
        <Panel>
            <header className="flex flex-wrap items-center gap-2">
                <code className="break-all text-sm text-ink-muted">
                    {release.chartName} {release.chartVersion}
                </code>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                <code className="break-all text-sm font-semibold text-ink">{target.chartVersion}</code>
                <Badge variant={upgrade.bump === 'major' ? 'attention' : 'neutral'}>
                    {upgrade.bump} bump
                </Badge>
                {/* Several repositories publish `nginx`. A name match is a
                    guess, and it has to be labelled as one; an attribution is
                    evidence-backed but still an inference, labelled distinctly. */}
                {matchKind === 'chart-name' && (
                    <Badge variant="muted">matched by chart name only</Badge>
                )}
                {matchKind === 'attributed' && (
                    <Badge variant="muted">matched via Artifact Hub</Badge>
                )}
                {upgrade.evidence === 'platform-render' && (
                    <Badge variant="muted">measured from chart defaults</Badge>
                )}
            </header>

            {/* A platform-render delta is as measured as a sibling one, but its
                source must be stated: default values, rendered from the chart's
                own tarball, run by nobody in this organisation. */}
            {upgrade.evidence === 'platform-render' && (
                <p className="mt-2 text-sm text-ink-muted">
                    Measured from the chart&apos;s default configuration — StackRadar rendered and
                    scanned the chart&apos;s own tarball; no release in your organisation runs this
                    version.
                </p>
            )}

            <p className="mt-3 text-sm text-ink">
                Moves <strong>{imageMoves.length}</strong> image
                {imageMoves.length === 1 ? '' : 's'}, clearing <strong>{totals.resolved}</strong>{' '}
                finding{totals.resolved === 1 ? '' : 's'}
                {totals.kev > 0 && (
                    <>
                        {' '}
                        including <KevBadge count={totals.kev} />
                    </>
                )}
                {totals.introduced > 0 && <>, introducing {totals.introduced}</>}.
            </p>

            {upgrade.bump === 'major' && (
                <p className="mt-2 flex items-start gap-2 text-sm text-attention">
                    <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                    A chart major can change the values schema. We can price the finding delta; we
                    cannot tell you whether your <code>values.yaml</code> still applies.
                </p>
            )}

            {/* Silent when either side is unknown — the server only sends this
                when the range demonstrably excludes the reported version. */}
            {upgrade.kubeWarning && target && (
                <p className="mt-2 flex items-start gap-2 text-sm text-attention">
                    <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                    Chart {target.chartVersion} requires Kubernetes{' '}
                    <code>{upgrade.kubeWarning.kubeRange}</code>; this cluster reports{' '}
                    <code>{upgrade.kubeWarning.clusterVersion}</code>.
                </p>
            )}

            {upgrade.unmeasuredImages > 0 && (
                <p className="mt-2 text-sm text-ink-muted">
                    {upgrade.unmeasuredImages} image
                    {upgrade.unmeasuredImages === 1 ? '' : 's'} the newer chart deploys{' '}
                    {upgrade.unmeasuredImages === 1 ? 'has' : 'have'} not been scanned, so
                    {upgrade.unmeasuredImages === 1 ? ' it is' : ' they are'} not in these numbers.
                </p>
            )}

            {/* The delivery layer matters: on an ArgoCD cluster a `helm
                upgrade` is reverted by the next sync. */}
            <p className="mt-3 text-sm text-ink">
                {delivery
                    ? `Delivered by ${delivery.tool}: bump targetRevision on app ${delivery.appName}.`
                    : `Run helm upgrade for this release.`}
            </p>
        </Panel>
    )
}

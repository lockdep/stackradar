'use client'

import { ArrowRight, CircleHelp, Layers } from 'lucide-react'
import { useResource } from '@/hooks'
import { Badge } from './Badge'
import { KevBadge } from './RiskScore'

/** One measured candidate base — `BaseCandidate` in the server's `base-upgrade.service.ts`. */
export interface BaseCandidate {
    kind: 'same-tag' | 'newer-tag'
    ref: string
    tag: string
    digest: string
    bump: 'major' | 'minor' | 'patch' | 'none'
    removes: number
    removesKev: number
    removesHigh: number
    introduces: number
    riskRemoved: number
}

export interface BaseUpgrade {
    base: { ref: string; layerCount: number | null }
    availability: 'available' | 'up-to-date' | 'no-candidates' | 'not-measured' | 'ambiguous-ordering'
    /** The image's findings in the base image — the M of "removes N of M". */
    baseFindings: number
    best: BaseCandidate | null
    candidates: BaseCandidate[]
    skipped: { tag: string; reason: string }[]
}

/** Why there is no rebuild to recommend, in the reader's words — never silence. */
const NO_RECOMMENDATION: Record<Exclude<BaseUpgrade['availability'], 'available'>, string> = {
    'up-to-date': 'Rebuilding on the newest comparable base would not remove any of them: the base is current.',
    'no-candidates': 'The base is not a public, tagged image, so there is nothing to compare it with.',
    'not-measured': 'A newer base may exist, but it has not been scanned yet. Check back after the next nightly pass.',
    'ambiguous-ordering': 'The base tag is not a version (for example "latest"), so newer tags cannot be ordered against it.',
}

/**
 * "Rebuilding on `node:20.18-bookworm-slim` removes 212 of 231 base-image
 * findings" — the one action the base-image bucket turns into, for an image
 * the organization builds. Read-only advice: the rebuild happens in the
 * reader's own pipeline, and nothing here can start it.
 *
 * Renders nothing while the base is unknown (the server answers
 * `recommendation: null`): there is nothing honest to say about a base
 * nobody could name.
 */
export function BaseUpgradePanel({ imageId }: { imageId: string }) {
    const { data } = useResource<{ recommendation: BaseUpgrade | null }>(`/api/images/${imageId}/base-upgrade`, {
        fallbackError: 'Could not load the base image recommendation',
    })
    const rec = data?.recommendation
    if (!rec) return null

    const best = rec.best
    return (
        <section className="rounded-lg border border-edge bg-surface-muted p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Layers aria-hidden="true" className="size-4 text-ink-muted" />
                Base image
                <code className="break-all font-mono text-xs font-normal text-ink-secondary">{rec.base.ref}</code>
            </h3>

            {best ? (
                <>
                    <p className="mt-2 text-sm text-ink">
                        Rebuilding on{' '}
                        <code className="break-all font-mono text-xs">{best.ref}</code> removes{' '}
                        <strong>{best.removes.toLocaleString()}</strong> of {rec.baseFindings.toLocaleString()}{' '}
                        base-image {rec.baseFindings === 1 ? 'finding' : 'findings'}.
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                        <span className="inline-flex items-center gap-1 font-mono">
                            {rec.base.ref.split(':').pop()}
                            <ArrowRight aria-hidden="true" className="size-3" />
                            {best.tag}
                        </span>
                        {best.kind === 'same-tag' ? (
                            <span title="The tag has been rebuilt upstream since this image was built. Rebuilding picks it up with no change to your Dockerfile.">
                                same tag, rebuilt upstream — no Dockerfile change
                            </span>
                        ) : (
                            <span>change the FROM line and rebuild</span>
                        )}
                        {best.bump === 'major' && <Badge variant="attention">major</Badge>}
                        {best.removesHigh > 0 && <span>· {best.removesHigh} high or critical</span>}
                        <KevBadge count={best.removesKev} />
                        {best.introduces > 0 && <span className="text-attention">· introduces {best.introduces}</span>}
                    </p>
                    <p className="mt-2 text-xs text-ink-muted">
                        Measured by scanning the newer base and comparing it with the findings in this image&apos;s base
                        layers. It says what the rebuild clears, not whether it is safe to deploy.
                    </p>
                </>
            ) : (
                <p className="mt-2 flex items-start gap-2 text-sm text-ink-muted">
                    <CircleHelp aria-hidden="true" className="mt-px size-4 shrink-0" />
                    <span>
                        {rec.baseFindings.toLocaleString()} {rec.baseFindings === 1 ? 'finding is' : 'findings are'} in
                        the base image. {NO_RECOMMENDATION[rec.availability === 'available' ? 'up-to-date' : rec.availability]}
                    </span>
                </p>
            )}
        </section>
    )
}

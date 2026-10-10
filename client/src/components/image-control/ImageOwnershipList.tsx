'use client'

import { EntityIcon } from '@/components/ui'
import {
    CONTROL_LABEL,
    controlReason,
    repositoryKey,
    type RepositoryControl,
} from '@/lib/image-control'

interface ImageOwnershipListProps {
    repositories: readonly RepositoryControl[]
    /** `true` = "we build this". A repository absent from the map shows what is in force. */
    ticked: ReadonlyMap<string, boolean>
    onToggle: (key: string, built: boolean) => void
    /** Demo mode, or a save in flight: the ticks are shown, not editable. */
    readOnly?: boolean
    /** The settings tab's extra column and per-row reset. */
    showDetected?: boolean
    onReset?: (repo: RepositoryControl) => void
}

/**
 * One row per image repository the org runs: a tick for "we build this", the
 * repository, and — muted — why we think what we think. Shared by the
 * Dashboard's set-up banner and the Image ownership settings tab, so the
 * question is asked and answered in one shape.
 */
export function ImageOwnershipList({
    repositories,
    ticked,
    onToggle,
    readOnly = false,
    showDetected = false,
    onReset,
}: ImageOwnershipListProps) {
    return (
        <ul className="divide-y divide-edge rounded-md border border-edge bg-surface-raised">
            {repositories.map(repo => {
                const key = repositoryKey(repo)
                const built = ticked.get(key) ?? repo.control === 'built'
                const id = `image-ownership-${key}`
                const reason = repo.rule
                    ? controlReason('rule', null)
                    : controlReason(repo.detected.detectedBy, repo.detected.detail)
                return (
                    <li key={key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                        <input
                            id={id}
                            type="checkbox"
                            checked={built}
                            disabled={readOnly}
                            onChange={e => onToggle(key, e.target.checked)}
                            className="mt-1 accent-accent-emphasis"
                        />
                        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                            <span className="flex items-center gap-1.5 text-sm text-ink">
                                <EntityIcon kind="image" className="size-4 shrink-0 text-ink-muted" />
                                <span className="break-all font-mono text-xs sm:text-sm">
                                    {repo.registry}/{repo.repository}
                                </span>
                                {repo.control === 'unknown' && (
                                    <span className="shrink-0 rounded-full border border-attention-muted bg-attention-subtle px-1.5 text-xs text-attention">
                                        {CONTROL_LABEL.unknown}
                                    </span>
                                )}
                            </span>
                            <span className="mt-0.5 block text-xs text-ink-muted">
                                {reason}
                                {repo.source && <> · source {repo.source}</>}
                                {' · '}
                                {repo.containerCount.toLocaleString()} {repo.containerCount === 1 ? 'container' : 'containers'}
                            </span>
                        </label>
                        {showDetected && (
                            <span className="flex shrink-0 items-center gap-3 text-xs text-ink-muted">
                                <span title={controlReason(repo.detected.detectedBy, repo.detected.detail)}>
                                    Detected: {CONTROL_LABEL[repo.detected.control]}
                                </span>
                                {repo.rule && onReset && !readOnly && (
                                    <button
                                        type="button"
                                        onClick={() => onReset(repo)}
                                        className="cursor-pointer text-accent hover:underline"
                                    >
                                        Reset to detected
                                    </button>
                                )}
                            </span>
                        )}
                    </li>
                )
            })}
        </ul>
    )
}

import type { CSSProperties } from 'react'
import Link from 'next/link'
import type { Container } from '@/types/container'
import { shortDigest } from '@/utils/containerUtils'
import { formatDate, formatImageName, formatShortDate, isDigestLikeTag } from '@/utils/formatters'
import { Badge, EntityIcon, ExposureDuration, TableRow, TableCell } from '@/components/ui'
import { RiskCell } from '@/components/ui'
import { ImageControlTag, type ControlChoice } from '@/components/image-control'
import { ContainerSeverityCell } from './ContainerSeverityCell'

/**
 * One running container.
 *
 * Two things this row is careful about, both of which the old project row got
 * to ignore because the model could not represent them:
 *
 * - **`vulnerabilities: null` renders as a dash, not as zeroes.** "Nobody has
 *   scanned this image" and "we scanned it and it is clean" are different
 *   things to say about a production container.
 * - **`workloadKind: null` renders as nothing, not as "Pod".** A guessed kind
 *   becomes a wrong `kubectl set image deployment/x` downstream.
 *
 * One row for two tables: the cluster tab (grouped under namespace rows, no
 * Cluster or Namespace cell) and the org-wide `/containers` page (flat, both
 * cells). The optional cells are props rather than a second row component so
 * the two lists cannot drift apart on what a container looks like.
 */
export function ContainerRow({
    container,
    depth,
    onSelect,
    cluster,
    showNamespace = false,
    checkedFrom = 'md',
    showOnImage = false,
    showController = false,
    onControlChange,
}: {
    container: Container
    depth: number
    onSelect: (container: Container) => void
    /**
     * Render a Cluster cell after the name — the org page, where rows from
     * every cluster share one table. `null` when the name is not known yet.
     */
    cluster?: { id: string; name: string } | null
    /** Render a Namespace cell after Cluster — the org page's flat list has no group row to carry it. */
    showNamespace?: boolean
    /**
     * The breakpoint the Checked column appears at. The org page, with two
     * more columns in the same width, collapses it one step later.
     */
    checkedFrom?: 'md' | 'xl'
    /**
     * Render a "Running this image for" cell after Checked — how long the container has
     * run this digest. The org page only, for now; the table that sets it
     * renders the matching header.
     */
    showOnImage?: boolean
    /**
     * Render "Controlled by" and "Pods" cells after Namespace — the columns of
     * a k9s or Lens pods list, on the org page. The kind then leaves the name
     * cell's badge from `xl`, where the column takes over.
     */
    showController?: boolean
    /**
     * Present when the reader may correct whose image this is: the tag in the
     * Image owner cell becomes a menu. The answer is per repository — see
     * `ImageControlTag`.
     */
    onControlChange?: ((container: Container, next: ControlChoice) => void) | undefined
}) {
    const showCluster = cluster !== undefined
    const imageName = formatImageName(container.imageRef)

    /* A digest-like "tag" — 64 hex, the bare image ID old scanners recorded
       for digest-pinned pods — renders as a digest, not as a 64-character
       tag. A digest-pinned deployment has no tag at all, so the digest is the
       only honest label; 12 hex characters carry it and the full value is in
       the hover. */
    const tag = container.imageTag?.trim()
    const hasTag = Boolean(tag && !isDigestLikeTag(tag))
    const digest = hasTag ? null : (container.imageDigest ?? tag ?? null)
    const imageSuffix = hasTag ? (
        <span className="text-ink-muted">:{tag}</span>
    ) : digest ? (
        <span className="text-ink-muted">@{shortDigest(digest)}</span>
    ) : null
    const imageTitle = hasTag
        ? `${imageName}:${tag}`
        : digest
          ? `${imageName}@${digest}`
          : (imageName ?? undefined)

    return (
        <TableRow hoverable aria-level={depth + 1}>
            <TableCell className="align-middle">
                <div
                    className="tree-indent flex items-center gap-2"
                    /* A wider step than the shared 20px scale: this tree is
                       exactly two levels deep, so the extra width buys clear
                       nesting under the group label and costs no column space —
                       unlike the dependency tree, where deep nesting is why the
                       shared scale stays narrow. */
                    style={{ '--tree-level': depth, '--tree-indent': '32px' } as CSSProperties}
                >
                    <button
                        type="button"
                        onClick={() => onSelect(container)}
                        className="group/name flex min-w-0 cursor-pointer items-center gap-2 text-left text-ink hover:text-accent"
                    >
                        <EntityIcon kind="container" className="size-4 text-ink-muted" />
                        <ScanDot subject={container} />
                        {/* `truncate` on the text spans, not the flex button — a
                            flex container clips without ever drawing the ellipsis. */}
                        <span className="min-w-0">
                            <span
                                className="block truncate underline-offset-2 group-hover/name:underline"
                                title={
                                    container.name !== container.workloadName
                                        ? `${container.workloadName} / ${container.name}`
                                        : container.workloadName
                                }
                            >
                                {container.workloadName}
                                {/* The container name only when it adds something —
                                    a container usually names its only container after
                                    themselves, and repeating it is noise. */}
                                {container.name !== container.workloadName && (
                                    <span className="text-ink-muted"> / {container.name}</span>
                                )}
                            </span>
                            {/* Where it runs, folded under the name while the
                                Cluster and Namespace columns are collapsed
                                (below `xl` on the org page): a phone reader
                                still sees which cluster and namespace the row
                                is about. Only the org page renders those
                                columns, so only it gets the line. */}
                            {(showCluster || showNamespace) && (
                                <span
                                    className="block truncate text-xs text-ink-muted xl:hidden"
                                    title={[cluster?.name, showNamespace ? container.namespaceName : null]
                                        .filter(Boolean)
                                        .join(' / ')}
                                >
                                    {showCluster && (cluster?.name ?? '—')}
                                    {showCluster && showNamespace && ' / '}
                                    {showNamespace && container.namespaceName}
                                </span>
                            )}
                        </span>
                    </button>

                    {/* `shrink-0`: when the fixed-width column runs out of room
                        it is the name that truncates, not the badges. Below
                        `sm` the badges go entirely — the kind is on the detail
                        page, and at 390px the column is the name or nothing. */}
                    <span className="hidden sm:contents">
                        {container.workloadKind && (
                            <Badge variant="neutral" className={showController ? 'shrink-0 xl:hidden' : 'shrink-0'}>
                                {container.workloadKind}
                            </Badge>
                        )}
                        {container.init && (
                            <Badge variant="neutral" className="shrink-0">
                                init
                            </Badge>
                        )}
                    </span>
                </div>
            </TableCell>

            {/* Both optional cells collapse with the header they sit under
                (`hideBelow="xl"` on the org page); Risk and the counts never
                collapse. The cluster link stops propagation so it does not
                also fire the row's `onSelect`. */}
            {showCluster && (
                <TableCell hideBelow="xl" className="truncate align-middle">
                    {cluster ? (
                        <Link
                            href={`/clusters/${cluster.id}`}
                            onClick={e => e.stopPropagation()}
                            className="inline-flex max-w-full items-center gap-1.5 text-ink underline-offset-2 hover:text-accent hover:underline"
                            title={cluster.name}
                        >
                            <EntityIcon kind="cluster" className="size-3.5 text-ink-muted" />
                            <span className="truncate">{cluster.name}</span>
                        </Link>
                    ) : (
                        <span className="text-ink-muted">—</span>
                    )}
                </TableCell>
            )}
            {showNamespace && (
                <TableCell hideBelow="xl" className="truncate align-middle text-ink-secondary">
                    <span title={container.namespaceName}>{container.namespaceName}</span>
                </TableCell>
            )}

            {showController && (
                <>
                    <TableCell hideBelow="xl" className="truncate align-middle text-ink-secondary">
                        {/* Null is "the scanner could not tell", never a kind of its own. */}
                        {container.workloadKind ?? (
                            <span className="text-ink-muted" title="The scanner could not resolve the pod's owner">—</span>
                        )}
                    </TableCell>
                    <TableCell hideBelow="xl" align="end" className="align-middle tabular-nums text-ink-secondary">
                        {container.runningPods ?? (
                            <span className="text-ink-muted" title="The scanner did not report a pod count">—</span>
                        )}
                    </TableCell>
                </>
            )}

            {/* `truncate`, not `whitespace-nowrap`: under the fixed table layout
                the column holds its width and a long registry path ellipsizes —
                the full ref is one hover away — instead of forcing the whole
                table into a horizontal scroll.

                The tag or digest rides inline after the name, as `repo:tag`
                or `repo@sha256:…`, the way a ref is written everywhere else.
                The name is ink and the suffix muted, so a column of rows
                still scans by repository.

                Collapsed below `sm` on both tables: at 390px the score and
                the four severity squares already take two thirds of the row,
                and the image is on the detail page one tap away. */}
            <TableCell hideBelow="md" className="truncate align-middle">
                {imageName ? (
                    <span title={imageTitle}>
                        <span className="text-ink">{imageName}</span>
                        {imageSuffix}
                    </span>
                ) : (
                    <span className="text-ink-muted">—</span>
                )}
            </TableCell>

            {/* Image owner — whose image it is, in a column of its own beside
                the image it describes. Collapses below `xl` on both tables. */}
            <TableCell hideBelow="xl" className="align-middle">
                <ImageControlTag
                    control={container.control}
                    detectedBy={container.controlDetectedBy}
                    detail={container.controlDetail}
                    repository={imageName ?? container.imageRef}
                    onChange={
                        onControlChange && container.repository
                            ? next => onControlChange(container, next)
                            : undefined
                    }
                />
            </TableCell>

            {/* `truncate`, not `whitespace-nowrap` — the column is `w-28` under
                a fixed table layout, so nowrap text would paint straight over
                the Risk column. The date-only form fits; the full timestamp is
                one hover away.

                The date shown is the last OSV-mirror match — the findings'
                freshness — not the SBOM's generation date, which is fixed for
                the life of the digest and lives in the hover text. */}
            <TableCell hideBelow={checkedFrom} className="truncate align-middle text-ink-muted">
                {container.lastMatchedAt ? (
                    <span
                        title={`Advisories checked ${formatDate(container.lastMatchedAt)} · SBOM generated ${formatDate(container.scannedAt)}`}
                    >
                        {formatShortDate(container.lastMatchedAt)}
                    </span>
                ) : container.scannedAt ? (
                    /* An SBOM exists but no match has completed — the state a
                       fresh upload sits in for the seconds before its scan job
                       runs. */
                    <span title={`SBOM generated ${formatDate(container.scannedAt)} · advisory check pending`}>
                        Pending
                    </span>
                ) : (
                    <span className="text-ink-muted">Not scanned</span>
                )}
            </TableCell>

            {showOnImage && (
                <TableCell hideBelow="xl" align="end" className="align-middle text-ink-muted">
                    <ExposureDuration
                        since={container.onImageSince}
                        isLowerBound={container.onImageSinceIsLowerBound}
                        reason="first-observation"
                    />
                </TableCell>
            )}

            <TableCell align="end" className="whitespace-nowrap align-middle">
                <RiskCell risk={container.risk} />
            </TableCell>

            <TableCell align="end" className="whitespace-nowrap align-middle">
                <ContainerSeverityCell vulnerabilities={container.vulnerabilities} />
            </TableCell>
        </TableRow>
    )
}

/**
 * The scan state at a glance, ahead of the name so it survives every
 * breakpoint the Checked column does not: filled blue scanned, amber
 * pending, hollow not scanned. The state is also in the hover and, for a
 * screen reader, in words — colour is never its only carrier. Exported for
 * the `/images` list, whose rows carry the same two dates.
 */
export function ScanDot({ subject }: { subject: Pick<Container, 'lastMatchedAt' | 'scannedAt'> }) {
    const [label, className] = subject.lastMatchedAt
        ? ['Scanned', 'bg-accent-emphasis']
        : subject.scannedAt
          ? ['Scan pending — SBOM uploaded, advisory check not finished', 'bg-attention-emphasis']
          : ['Not scanned — no SBOM for this image', 'border border-edge-strong']
    return (
        <span title={label} className={`size-2 shrink-0 rounded-full ${className}`}>
            <span className="sr-only">{label}</span>
        </span>
    )
}

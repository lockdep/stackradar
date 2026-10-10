'use client'

import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, AlertCircle, Trash2, Code2, ChevronDown, ChevronUp, Layers } from 'lucide-react'
import {
    Spinner,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui'
import {
    formatTimeAgo,
    formatDuration,
    formatNumber,
    formatLag,
    computeLagSeconds,
    thresholdTone,
    OSV_LAG_WARNING_SECONDS,
    OSV_LAG_CRITICAL_SECONDS,
} from './utils'
import type { OsvSyncState, OsvSyncRun, OsvParseFailures, OsvValidationWarnings, ParseFailuresPage, OsvGeneration } from './types'

// ── OsvStateCard ───────────────────────────────────────────────────────────

/**
 * The mirror has no complete generation and the scheduled sync will not build
 * one — it refuses to bootstrap by design, so an hourly trigger can never start
 * an unresumable multi-hour rebuild off a cleared flag.
 *
 * That makes this state a call to action rather than a status. Rendering it as
 * a plain amber "not yet initialized" reads as "it is working on it", which is
 * the opposite of true: nothing will change until a person runs the bootstrap,
 * and meanwhile vulnerability matching is being refused with 503.
 */
function NotInitializedNotice() {
    return (
        <div className="rounded-md bg-attention-subtle border border-attention-muted p-3 space-y-2">
            {/* No heading — the status line directly above already says
                "Not yet initialized". What it cannot say is that this will not
                resolve on its own, which is the whole point of this block. */}
            <p className="text-xs text-ink-secondary leading-relaxed">
                <strong className="font-semibold text-attention">This will not resolve on its own.</strong>{' '}
                Vulnerability matching is being refused with 503 and scan jobs are deferring. The
                hourly sync declines to start a full rebuild on a schedule, so it will never build
                the first generation. Run the one-shot bootstrap job:
            </p>
            <code className="block rounded-sm bg-surface-muted px-2 py-1.5 text-xs font-mono text-ink-secondary break-all">
                apps/manual/osv-bootstrap-job.yaml
            </code>
            <p className="text-xs text-ink-muted">
                Locally, the equivalent is <span className="font-mono">pnpm osv-sync --full-refresh</span>.
            </p>
        </div>
    )
}

/**
 * Which ecosystems the mirror carries (`OSV_ECOSYSTEMS`, open-source plan
 * step 06). Two lists because they can disagree: `mirrored` is what the
 * last bootstrap built, `configured` is what the server now wants, and the
 * incremental sync cannot close the gap — only the next bootstrap check
 * does, so a widened scope is called out until it has.
 */
function OsvEcosystems({ mirrored, configured }: { mirrored: string[] | null; configured: string[] | null | undefined }) {
    const describe = (list: string[] | null) => (list === null ? 'All ecosystems' : `${list.length} ecosystems`)
    const missing =
        configured === undefined || mirrored === null
            ? []
            : configured === null
              ? ['everything']
              : configured.filter(name => !mirrored.includes(name))

    return (
        <div className="space-y-1 text-sm">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                <div className="text-ink-muted">Mirror scope</div>
                <div className="text-ink-secondary font-medium" title={mirrored?.join(', ')}>
                    {describe(mirrored)}
                </div>
            </div>
            {mirrored !== null && (
                <div className="text-xs text-ink-muted break-words">{mirrored.join(', ')}</div>
            )}
            {missing.length > 0 && (
                <div className="rounded-md bg-attention-subtle border border-attention-muted p-2 text-xs text-attention">
                    OSV_ECOSYSTEMS now asks for {missing.join(', ')}, which the mirror was not built with. The hourly
                    sync cannot add ecosystems; the next bootstrap check (start-up, then twice a day) rebuilds, or run{' '}
                    <span className="font-mono">pnpm osv-sync --full-refresh</span>.
                </div>
            )}
        </div>
    )
}

export function OsvStateCard({
    state,
    generations = [],
    configuredEcosystems,
}: {
    state: OsvSyncState | null
    generations?: OsvGeneration[]
    configuredEcosystems?: string[] | null
}) {
    if (!state) {
        return (
            <div className="flex items-center gap-2 text-ink-muted text-sm">
                <AlertCircle className="size-4" />
                No sync state found — OSV sync has never run.
            </div>
        )
    }

    const statusColor: Record<string, string> = {
        idle: 'text-ink-muted',
        incremental: 'text-accent',
        full_refresh: 'text-info',
    }

    const lagSeconds = computeLagSeconds(state.lastModifiedSeen, state.lastModifiedApplied)
    // Same thresholds as the Overview tile, from utils, so the two cannot
    // disagree about what "behind" means.
    const lagColor: Record<string, string> = {
        neutral: 'text-ink-secondary',
        good: 'text-ink-secondary',
        warn: 'text-attention',
        bad: 'text-danger',
    }
    const lagTone = thresholdTone(lagSeconds, OSV_LAG_WARNING_SECONDS, OSV_LAG_CRITICAL_SECONDS)
    const building = generations.filter(g => !g.isCurrent)

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                {state.initialized ? (
                    <CheckCircle className="size-4 text-success" />
                ) : (
                    <AlertCircle className="size-4 text-attention" />
                )}
                <span className="text-sm font-medium text-ink-secondary">
                    {state.initialized ? 'Initialized' : 'Not yet initialized'}
                </span>
                <span className={`text-xs font-medium ml-auto ${statusColor[state.syncStatus] ?? 'text-ink-muted'}`}>
                    {state.syncStatus}
                </span>
            </div>

            {!state.initialized && <NotInitializedNotice />}

            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <div className="text-ink-muted">Last poll</div>
                <div className="text-ink-secondary font-medium">{formatTimeAgo(state.lastSuccessfulPollAt)}</div>
                <div className="text-ink-muted">Watermark</div>
                <div className="text-ink-secondary font-medium">{formatTimeAgo(state.lastModifiedApplied)}</div>
                {/* Distinct from watermark age: that grows whenever OSV publishes
                    nothing, which is healthy. This is the gap between what OSV
                    has published and what we have applied. */}
                <div className="text-ink-muted">Behind upstream</div>
                <div className={`font-medium ${lagColor[lagTone]}`}>
                    {lagSeconds === null ? '—' : lagSeconds === 0 ? 'Up to date' : formatLag(lagSeconds)}
                </div>
                <div className="text-ink-muted">Consecutive failures</div>
                <div className={`font-medium ${state.consecutiveFailures > 0 ? 'text-danger' : 'text-ink-secondary'}`}>
                    {state.consecutiveFailures}
                </div>
                <div className="text-ink-muted">Last full rebuild</div>
                <div className="text-ink-secondary font-medium">{formatTimeAgo(state.lastFullRefreshAt)}</div>
            </div>

            {state.initialized && <OsvEcosystems mirrored={state.ecosystems} configured={configuredEcosystems} />}

            <OsvGenerations generations={generations} current={state.affectedPkgGeneration} building={building} />

            {state.lastError && (
                <div className="rounded-md bg-danger-subtle border border-danger-muted p-3 text-xs text-danger font-mono break-all">
                    {state.lastError}
                </div>
            )}
        </div>
    )
}

/**
 * Affected-package generations. Normally one line stating the obvious; the
 * reason it exists is the other two cases.
 *
 * A rebuild writes generation N+1 alongside the live N and only swaps the
 * pointer when the whole thing has succeeded, so during a bootstrap this is the
 * only progress indicator there is — everything else reports on the generation
 * still serving reads and looks perfectly healthy. A non-current generation
 * with no rebuild running means rows orphaned by one that died before it could
 * clean up, which otherwise shows only as a table twice the size it should be.
 */
function OsvGenerations({ generations, current, building }: {
    generations: OsvGeneration[]
    current: number
    building: OsvGeneration[]
}) {
    if (generations.length === 0) return null

    const live = generations.find(g => g.isCurrent)

    return (
        <div className="rounded-md border border-edge bg-surface-muted p-3 space-y-2">
            <div className="flex items-center gap-2">
                <Layers className="size-3.5 text-ink-faint" />
                <span className="text-xs font-medium text-ink-secondary">Affected-package generations</span>
            </div>
            <div className="space-y-1">
                {generations.map(g => (
                    <div key={g.generation} className="flex items-center justify-between text-xs">
                        <span className="text-ink-muted font-mono">
                            gen {g.generation}
                            {g.isCurrent
                                ? <span className="ml-1.5 text-success font-sans font-medium">live</span>
                                : <span className="ml-1.5 text-info font-sans font-medium">building</span>}
                        </span>
                        <span className="font-medium text-ink-secondary">{formatNumber(g.rowCount)} rows</span>
                    </div>
                ))}
            </div>
            {building.length > 0 && live && (
                <p className="text-xs text-ink-muted">
                    Rebuild in progress — {formatNumber(building[0].rowCount)} of roughly{' '}
                    {formatNumber(live.rowCount)} rows written. Generation {current} keeps serving
                    reads until the swap.
                </p>
            )}
            {building.length > 0 && !live && (
                <p className="text-xs text-attention">
                    No rows in the live generation ({current}). These belong to a rebuild that never
                    completed the swap.
                </p>
            )}
        </div>
    )
}

// ── OsvParseFailuresCard ───────────────────────────────────────────────────

/**
 * Two different things share the `osv_sync_failures` table, and only one of
 * them is bad news. A parse failure means the advisory is missing from the
 * mirror. A validation warning means it deviated from the OSV schema and was
 * ingested regardless — usually because the publisher violated the spec.
 * They are rendered apart, and only failures get danger colour, because
 * showing one number made ~25,000 warnings read as a broken mirror.
 */
export function OsvParseFailuresCard({ parseFailures, validationWarnings, onClear }: {
    parseFailures: OsvParseFailures
    validationWarnings: OsvValidationWarnings
    onClear: () => void
}) {
    const [clearing, setClearing] = useState(false)
    const hasAny = parseFailures.total > 0
    const storedRows = parseFailures.total + validationWarnings.total

    const handleClear = async () => {
        // The endpoint truncates the whole table, warnings included — so the
        // count in the prompt has to be both, not just the failures above it.
        if (!confirm(`Delete all ${formatNumber(storedRows)} recorded failures and warnings? This cannot be undone.`)) return
        setClearing(true)
        try {
            await fetch('/api/admin/osv/parse-failures', { method: 'DELETE' })
            onClear()
        } finally {
            setClearing(false)
        }
    }

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
                <div className={`rounded-md p-3 text-center ${hasAny ? 'bg-danger-subtle' : 'bg-success-subtle'}`}>
                    <p className={`text-xl font-bold ${hasAny ? 'text-danger' : 'text-success'}`}>
                        {formatNumber(parseFailures.total)}
                    </p>
                    <p className={`text-xs font-medium mt-0.5 ${hasAny ? 'text-danger' : 'text-success'}`}>Records not ingested</p>
                </div>
                <div className={`rounded-md p-3 text-center ${parseFailures.last7Days > 0 ? 'bg-attention-subtle' : 'bg-surface-muted'}`}>
                    <p className={`text-xl font-bold ${parseFailures.last7Days > 0 ? 'text-attention' : 'text-ink-secondary'}`}>
                        {formatNumber(parseFailures.last7Days)}
                    </p>
                    <p className={`text-xs font-medium mt-0.5 ${parseFailures.last7Days > 0 ? 'text-attention' : 'text-ink-muted'}`}>Last 7 days</p>
                </div>
            </div>
            {Object.keys(parseFailures.byType).length > 0 && (
                <div className="space-y-1">
                    {Object.entries(parseFailures.byType).map(([type, n]) => (
                        <div key={type} className="flex items-center justify-between text-sm">
                            <span className="text-ink-muted font-mono text-xs">{type}</span>
                            <span className="font-medium text-ink-secondary">{formatNumber(n)}</span>
                        </div>
                    ))}
                </div>
            )}
            <div className="border-t border-edge pt-3 space-y-1">
                <div className="flex items-baseline justify-between text-sm">
                    <span className="text-ink-secondary">Schema warnings</span>
                    <span className="font-medium text-ink-secondary">
                        {formatNumber(validationWarnings.total)}
                        {validationWarnings.last7Days > 0 && (
                            <span className="text-ink-muted font-normal"> · {formatNumber(validationWarnings.last7Days)} in 7d</span>
                        )}
                    </span>
                </div>
                <p className="text-xs text-ink-muted">
                    Ingested successfully but deviating from the OSV schema — usually the
                    publisher violating the spec. Not data loss.
                </p>
            </div>

            {!hasAny && (
                <p className="text-xs text-success flex items-center gap-1.5">
                    <CheckCircle className="size-3.5" /> Every advisory was ingested
                </p>
            )}
            {hasAny && (
                <button
                    onClick={handleClear}
                    disabled={clearing}
                    className="flex items-center gap-1.5 text-xs text-danger hover:underline disabled:opacity-50 cursor-pointer mt-1"
                >
                    <Trash2 className="size-3.5" />
                    {clearing ? 'Clearing…' : 'Clear all records'}
                </button>
            )}
        </div>
    )
}

// ── ParseFailureDetail ─────────────────────────────────────────────────────

function ParseFailureDetail({ id, onClose }: { id: number; onClose: () => void }) {
    const [errorMsg, setErrorMsg] = useState<string | null>(null)
    const [rawData, setRawData] = useState<object | null>(null)
    const [loadingError, setLoadingError] = useState(false)
    const [loadingRaw, setLoadingRaw] = useState(false)
    const [rawError, setRawError] = useState<string | null>(null)

    useEffect(() => {
        setLoadingError(true)
        fetch(`/api/admin/osv/parse-failures/${id}`, { cache: 'no-store' })
            .then(r => r.json())
            .then((d: { errorMessage?: string }) => setErrorMsg(d.errorMessage ?? ''))
            .catch(() => setErrorMsg('Failed to load error message'))
            .finally(() => setLoadingError(false))
    }, [id])

    const fetchRaw = () => {
        setLoadingRaw(true)
        setRawError(null)
        fetch(`/api/admin/osv/parse-failures/${id}/raw`, { cache: 'no-store' })
            .then(async r => {
                const body = await r.json()
                if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`)
                return body
            })
            .then(setRawData)
            .catch(e => setRawError(e instanceof Error ? e.message : 'Failed to load'))
            .finally(() => setLoadingRaw(false))
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-backdrop">
            <div className="bg-surface-raised rounded-md border border-edge shadow-floating w-full max-w-2xl max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between p-4 border-b border-edge">
                    <h3 className="text-sm font-semibold text-ink">Parse failure #{id}</h3>
                    <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary cursor-pointer text-lg leading-none">×</button>
                </div>
                <div className="overflow-y-auto p-4 space-y-4 flex-1">
                    <div>
                        <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-1.5">Error message</p>
                        {loadingError ? (
                            <div className="flex justify-center py-4"><Spinner size="sm" className="text-ink-faint" /></div>
                        ) : (
                            <pre className="text-xs text-danger bg-danger-subtle border border-danger-muted rounded-md p-3 whitespace-pre-wrap break-all font-mono">
                                {errorMsg}
                            </pre>
                        )}
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <p className="text-xs font-medium text-ink-muted uppercase tracking-wide">Raw OSV data</p>
                            {!rawData && (
                                <button
                                    onClick={fetchRaw}
                                    disabled={loadingRaw}
                                    className="flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50 cursor-pointer"
                                >
                                    <Code2 className="size-3.5" />
                                    {loadingRaw ? 'Fetching…' : 'Fetch raw data'}
                                </button>
                            )}
                        </div>
                        {rawError && (
                            <p className="text-xs text-danger bg-danger-subtle rounded-sm px-2 py-1">{rawError}</p>
                        )}
                        {rawData && (
                            <pre className="text-xs text-ink-secondary bg-surface-muted border border-edge rounded-md p-3 whitespace-pre-wrap break-all font-mono overflow-x-auto max-h-64">
                                {JSON.stringify(rawData, null, 2)}
                            </pre>
                        )}
                        {!rawData && !rawError && !loadingRaw && (
                            <p className="text-xs text-ink-muted">Not loaded — click "Fetch raw data" to retrieve the OSV advisory JSON.</p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

// ── ParseFailuresTable ─────────────────────────────────────────────────────

export function ParseFailuresTable({ refreshKey }: { refreshKey: number }) {
    const [page, setPage] = useState<ParseFailuresPage | null>(null)
    const [loading, setLoading] = useState(true)
    const [offset, setOffset] = useState(0)
    const [selectedId, setSelectedId] = useState<number | null>(null)
    const limit = 20

    useEffect(() => {
        setLoading(true)
        fetch(`/api/admin/osv/parse-failures?limit=${limit}&offset=${offset}`, { cache: 'no-store' })
            .then(r => r.json())
            .then((d: ParseFailuresPage) => setPage(d))
            .catch(() => setPage(null))
            .finally(() => setLoading(false))
    }, [offset, refreshKey])

    if (loading) {
        return <div className="flex justify-center py-8"><Spinner size="sm" className="text-ink-faint" /></div>
    }

    if (!page || page.failures.length === 0) {
        return <p className="text-sm text-ink-muted">No failure records found.</p>
    }

    const totalPages = Math.ceil(page.total / limit)
    const currentPage = Math.floor(offset / limit) + 1

    return (
        <>
            <TableContainer variant="plain">
                <Table aria-label="Sync failure records">
                    <TableHead>
                        <TableHeader>ID</TableHeader>
                        <TableHeader>Type</TableHeader>
                        <TableHeader>OSV ID</TableHeader>
                        <TableHeader hideBelow="md">Ecosystem</TableHeader>
                        <TableHeader hideBelow="lg">Source path</TableHeader>
                        <TableHeader align="end" hideBelow="sm">When</TableHeader>
                    </TableHead>
                    <TableBody>
                        {page.failures.map(f => (
                            <TableRow
                                key={f.id}
                                onClick={() => setSelectedId(f.id)}
                            >
                                <TableCell className="text-xs text-ink-muted font-mono">
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            setSelectedId(f.id)
                                        }}
                                        className="cursor-pointer rounded-sm hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                    >
                                        <span className="sr-only">View parse failure </span>
                                        {f.id}
                                    </button>
                                </TableCell>
                                <TableCell>
                                    <span className={`text-xs px-1.5 py-0.5 rounded-sm font-medium ${f.errorType === 'parse_error' ? 'bg-danger-subtle text-danger' : 'bg-attention-subtle text-attention'}`}>
                                        {f.errorType}
                                    </span>
                                </TableCell>
                                <TableCell className="text-xs font-mono text-ink-secondary break-all">{f.osvId ?? <span className="text-ink-muted">—</span>}</TableCell>
                                <TableCell hideBelow="md" className="text-xs text-ink-muted">{f.ecosystemDir ?? <span className="text-ink-muted">—</span>}</TableCell>
                                <TableCell hideBelow="lg" className="text-xs text-ink-muted font-mono max-w-56 truncate" title={f.sourcePath}>{f.sourcePath}</TableCell>
                                <TableCell align="end" hideBelow="sm" className="text-xs text-ink-muted whitespace-nowrap">{formatTimeAgo(f.occurredAt)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>

            {totalPages > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-edge">
                    <span className="text-xs text-ink-muted">{formatNumber(page.total)} total · page {currentPage} of {totalPages}</span>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setOffset(Math.max(0, offset - limit))}
                            disabled={offset === 0}
                            className="flex items-center gap-1 text-xs text-ink-secondary hover:text-ink disabled:opacity-40 cursor-pointer"
                        >
                            <ChevronDown className="size-3.5 rotate-90" /> Prev
                        </button>
                        <button
                            onClick={() => setOffset(offset + limit)}
                            disabled={offset + limit >= page.total}
                            className="flex items-center gap-1 text-xs text-ink-secondary hover:text-ink disabled:opacity-40 cursor-pointer"
                        >
                            Next <ChevronUp className="size-3.5 rotate-90" />
                        </button>
                    </div>
                </div>
            )}

            {selectedId !== null && (
                <ParseFailureDetail id={selectedId} onClose={() => setSelectedId(null)} />
            )}
        </>
    )
}

// ── OsvRunRow ──────────────────────────────────────────────────────────────

export function OsvRunRow({ run }: { run: OsvSyncRun }) {
    return (
        <TableRow>
            <TableCell>
                {run.success ? (
                    <CheckCircle className="size-3.5 text-success" />
                ) : (
                    <XCircle className="size-3.5 text-danger" />
                )}
            </TableCell>
            <TableCell className="text-xs text-ink-muted whitespace-nowrap">{formatTimeAgo(run.completedAt)}</TableCell>
            {/* The `hideBelow` values here pair with the headers in
                `OsvTab.tsx` — change both or the columns shift. */}
            <TableCell hideBelow="sm">
                <span className="text-xs px-1.5 py-0.5 rounded-sm bg-surface-hover text-ink-secondary font-medium whitespace-nowrap">{run.mode}</span>
            </TableCell>
            <TableCell align="end" hideBelow="md" className="text-xs text-ink-secondary">{formatNumber(run.recordsProcessed)}</TableCell>
            <TableCell align="end" hideBelow="md" className="text-xs text-success">+{formatNumber(run.inserted)}</TableCell>
            <TableCell align="end" hideBelow="md" className="text-xs text-accent">~{formatNumber(run.updated)}</TableCell>
            {/* Unchanged is the useful one on a quiet run: it says the overlap
                window re-read records and correctly left them alone. It was
                permanently 0 until the upsert started returning (xmax = 0),
                which is why nothing rendered it. */}
            <TableCell align="end" hideBelow="lg" className="text-xs text-ink-muted">{run.unchanged > 0 ? formatNumber(run.unchanged) : '—'}</TableCell>
            <TableCell align="end" className="text-xs text-danger">{run.parseFailures > 0 ? run.parseFailures : '—'}</TableCell>
            <TableCell align="end" hideBelow="md" className="text-xs text-ink-muted whitespace-nowrap">
                {run.lagSeconds === null ? '—' : formatLag(Math.floor(run.lagSeconds))}
            </TableCell>
            <TableCell align="end" hideBelow="lg" className="text-xs text-ink-muted whitespace-nowrap">{formatDuration(run.durationMs)}</TableCell>
        </TableRow>
    )
}

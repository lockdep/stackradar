'use client';

import { useState } from 'react';
import { Globe, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Badge, Button, Spinner } from '@/components/ui';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { formatRelativeTime } from '@/utils/formatters';
import { useChartRepositories, type ChartRepositoryRow } from './useChartRepositories';

/**
 * Chart repositories.
 *
 * What feeds the Fixes page's *unmeasured* band: each repository's `index.yaml`
 * can say a newer chart exists, and nothing more. Rows are auto-registered
 * from repositories observed on releases; private hubs are added here with
 * credentials; a chart with an unknown repository can be looked up on
 * Artifact Hub — and that mapping is stored only after the user confirms it,
 * because a name match is a guess.
 */

interface ArtifactHubCandidate {
    packageName: string;
    repoName: string;
    repoUrl: string;
    publisher: string | null;
    verifiedPublisher: boolean;
}

const SOURCE_LABEL: Record<ChartRepositoryRow['source'], string> = {
    observed: 'observed in cluster',
    manual: 'added manually',
    'artifact-hub-confirmed': 'Artifact Hub, confirmed',
    'artifact-hub-matched': 'Artifact Hub, matched',
};

type RefreshJob = {
    id: string;
    status: 'pending' | 'scheduled' | 'processing' | 'completed' | 'failed' | 'cancelled';
    result?: { status?: 'ok' | 'not-modified' | 'error'; error?: string | null } | null;
    errorMessage?: string | null;
};

const REFRESH_POLL_MS = 2_000;
const REFRESH_POLL_LIMIT = 60;

/**
 * Refresh is asynchronous: the server enqueues a job (the index is fetched
 * and parsed by the worker, never in the API process) and we poll it to
 * completion. Resolves to a one-line outcome for the row.
 */
async function refreshAndWait(repoId: string): Promise<string> {
    const accepted = await apiFetch<{ job: RefreshJob }>(`/api/chart-repositories/${repoId}/refresh`, {
        method: 'POST',
    });
    let job = accepted.job;
    for (let i = 0; i < REFRESH_POLL_LIMIT; i++) {
        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') break;
        await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
        job = await apiFetch<RefreshJob>(`/api/jobs/${job.id}`);
    }
    if (job.status === 'completed') {
        const status = job.result?.status;
        return status === 'not-modified' ? 'Index unchanged.' : status === 'ok' ? 'Index refreshed.' : '';
    }
    if (job.status === 'failed') throw new Error(job.errorMessage ?? 'Refresh failed');
    return job.status === 'cancelled' ? 'Refresh cancelled.' : 'Refresh still running — check back shortly.';
}

function RepositoryRow({
    repo,
    canManage,
    onChanged,
}: {
    repo: ChartRepositoryRow;
    canManage: boolean;
    onChanged: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [refreshOutcome, setRefreshOutcome] = useState<string | null>(null);

    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await fn();
            onChanged();
        } finally {
            setBusy(false);
        }
    };

    return (
        <li className="rounded-md border border-edge bg-surface-raised p-3">
            <div className="flex flex-wrap items-center gap-2">
                <Globe aria-hidden className="size-4 shrink-0 text-ink-muted" />
                <code className="min-w-0 break-all text-sm text-ink">{repo.url}</code>
                <Badge variant="muted">{SOURCE_LABEL[repo.source]}</Badge>
                {repo.hasCredentials && <Badge variant="neutral">credentials set</Badge>}
                {!repo.enabled && <Badge variant="attention">disabled</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                {repo.lastFetchError ? (
                    <span className="text-danger">Last fetch failed: {repo.lastFetchError}</span>
                ) : repo.lastFetchedAt ? (
                    <span>Index fetched {formatRelativeTime(repo.lastFetchedAt)}</span>
                ) : (
                    <span>Not fetched yet — the daily sync will pick it up</span>
                )}
                {refreshOutcome && <span>{refreshOutcome}</span>}
                {canManage && (
                    <span className="ml-auto flex gap-1.5">
                        <Button
                            size="sm"
                            variant="invisible"
                            disabled={busy}
                            onClick={() =>
                                run(async () => {
                                    const outcome = await refreshAndWait(repo.id);
                                    setRefreshOutcome(outcome || null);
                                })
                            }
                        >
                            <RefreshCw aria-hidden className="size-3.5" /> Refresh
                        </Button>
                        <Button
                            size="sm"
                            variant="invisible"
                            disabled={busy}
                            onClick={() =>
                                run(() =>
                                    apiFetch(`/api/chart-repositories/${repo.id}`, {
                                        method: 'PATCH',
                                        json: { enabled: !repo.enabled },
                                    }),
                                )
                            }
                        >
                            {repo.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                            size="sm"
                            variant="invisible"
                            disabled={busy}
                            onClick={() =>
                                run(() => apiFetch(`/api/chart-repositories/${repo.id}`, { method: 'DELETE' }))
                            }
                        >
                            <Trash2 aria-hidden className="size-3.5" /> Remove
                        </Button>
                    </span>
                )}
            </div>
        </li>
    );
}

function AddRepositoryForm({ onAdded }: { onAdded: () => void }) {
    const [url, setUrl] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await apiFetch('/api/chart-repositories', {
                method: 'POST',
                json: {
                    url: url.trim(),
                    source: 'manual',
                    ...(username.trim() ? { username: username.trim() } : {}),
                    ...(password ? { password } : {}),
                },
            });
            setUrl('');
            setUsername('');
            setPassword('');
            onAdded();
        } catch (e) {
            setError(errorMessage(e, 'Failed to add repository'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-md border border-edge bg-surface-raised p-3">
            <h4 className="text-sm font-semibold text-ink">Add a repository</h4>
            <p className="mt-1 text-xs text-ink-muted">
                The base URL that serves <code>index.yaml</code> — Bitnami, ChartMuseum, Harbor, GitHub-Pages-hosted
                repos. Credentials are optional and only needed for private hubs. OCI registries are not supported yet.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
                <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://charts.example.com"
                    className="min-w-64 flex-1 rounded-md border border-edge-strong bg-surface-muted p-2 text-sm text-ink placeholder:text-ink-faint"
                />
                <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="username (optional)"
                    autoComplete="off"
                    className="w-44 rounded-md border border-edge-strong bg-surface-muted p-2 text-sm text-ink placeholder:text-ink-faint"
                />
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="password (optional)"
                    autoComplete="new-password"
                    className="w-44 rounded-md border border-edge-strong bg-surface-muted p-2 text-sm text-ink placeholder:text-ink-faint"
                />
                <Button variant="primary" loading={busy} disabled={!url.trim()} onClick={submit}>
                    Add
                </Button>
            </div>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>
    );
}

function DiscoverChart({ chart, onConfirmed }: { chart: string; onConfirmed: () => void }) {
    const [candidates, setCandidates] = useState<ArtifactHubCandidate[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const search = async () => {
        setBusy(true);
        setError(null);
        try {
            const out = await apiFetch<{ candidates?: ArtifactHubCandidate[] }>(
                `/api/chart-repositories/discover?chart=${encodeURIComponent(chart)}`,
            );
            setCandidates(out.candidates ?? []);
        } catch (e) {
            setError(errorMessage(e, 'Lookup failed'));
        } finally {
            setBusy(false);
        }
    };

    const confirm = async (candidate: ArtifactHubCandidate) => {
        setBusy(true);
        setError(null);
        try {
            await apiFetch('/api/chart-repositories', {
                method: 'POST',
                json: { url: candidate.repoUrl, source: 'artifact-hub-confirmed' },
            });
            onConfirmed();
        } catch (e) {
            setError(errorMessage(e, 'Failed to register'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <li className="rounded-md border border-edge bg-surface-raised p-3">
            <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm text-ink">{chart}</code>
                <span className="text-xs text-ink-muted">repository unknown</span>
                <span className="ml-auto">
                    <Button size="sm" variant="secondary" loading={busy} onClick={search}>
                        <Search aria-hidden className="size-3.5" /> Find on Artifact Hub
                    </Button>
                </span>
            </div>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            {candidates != null && (
                <div className="mt-2">
                    {candidates.length === 0 ? (
                        <p className="text-sm text-ink-muted">
                            No chart named <code>{chart}</code> on Artifact Hub.
                        </p>
                    ) : (
                        <>
                            <p className="text-xs text-ink-muted">
                                A name match is a guess — name collisions exist. Confirm only a repository you
                                recognise; nothing is stored until you do.
                            </p>
                            <ul className="mt-1 space-y-1">
                                {candidates.map((c) => (
                                    <li key={c.repoUrl} className="flex flex-wrap items-center gap-2 text-sm">
                                        <code className="break-all text-ink">{c.repoUrl}</code>
                                        <span className="text-xs text-ink-muted">
                                            {c.repoName}
                                            {c.publisher ? ` · ${c.publisher}` : ''}
                                        </span>
                                        {c.verifiedPublisher && <Badge variant="success">verified publisher</Badge>}
                                        <Button
                                            size="sm"
                                            variant="invisible"
                                            disabled={busy}
                                            onClick={() => confirm(c)}
                                        >
                                            Confirm &amp; register
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            )}
        </li>
    );
}

export function ChartRepositoriesTab({ canManage }: { canManage: boolean }) {
    // Mutations (add, enable/disable, refresh, remove, confirm a discovery)
    // are admin/owner-only on the server; members get the read-only listing.
    const { repositories, unknownCharts, error, refresh } = useChartRepositories();

    if (error) return <p className="py-8 text-center text-sm text-danger">{error}</p>;
    if (repositories == null) {
        return (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-muted">
                <Spinner size="sm" /> Loading…
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <p className="text-sm text-ink-muted">
                Chart repositories tell the Fixes page when a newer chart <em>exists</em>. That is all an index can say
                — a &quot;newer chart&quot; suggestion never claims what upgrading fixes until the newer version&apos;s
                images are measured.
            </p>

            {repositories.length > 0 ? (
                <ul className="space-y-2">
                    {repositories.map((repo) => (
                        <RepositoryRow
                            key={repo.id}
                            repo={repo}
                            canManage={canManage}
                            onChanged={() => void refresh()}
                        />
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-ink-muted">
                    No repositories yet. Repositories observed on your releases are registered automatically by the
                    daily sync; private hubs can be added below.
                </p>
            )}

            {canManage && <AddRepositoryForm onAdded={() => void refresh()} />}

            {canManage && unknownCharts.length > 0 && (
                <section>
                    <h4 className="text-sm font-semibold text-ink">Charts with an unknown repository</h4>
                    <p className="mt-1 text-xs text-ink-muted">
                        These charts run in your clusters but no GitOps source object named their repository. Artifact
                        Hub can suggest one; you confirm it.
                    </p>
                    <ul className="mt-2 space-y-2">
                        {unknownCharts.map((chart) => (
                            <DiscoverChart key={chart} chart={chart} onConfirmed={() => void refresh()} />
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

'use client';

import { FileWarning } from 'lucide-react';
import { TableContainer, Table, TableHead, TableBody, TableHeader } from '@/components/ui';
import { useTabData } from './useTabData';
import { TabShell } from './Shared';
import { ActionButton } from './ActionButton';
import { OsvStateCard, OsvParseFailuresCard, OsvRunRow, ParseFailuresTable } from './OsvComponents';
import type { OsvStatus } from './types';

export function OsvTab({ refreshKey, onLoadingChange }: { refreshKey: number; onLoadingChange: (v: boolean) => void }) {
    // Clearing the failure records reloads the same two things a Retry does:
    // the tab payload, and the failure table below it (via reloadKey).
    const { data, isLoading, error, refetch, reloadKey } = useTabData<OsvStatus>(
        '/api/admin/osv',
        refreshKey,
        onLoadingChange,
    );

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data && (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="bg-surface-raised rounded-md border border-edge p-5">
                            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                                <h2 className="text-sm font-semibold text-ink-secondary">Mirror State</h2>
                                {/* The scheduler's own runners, behind the same advisory
                                    lock as the hourly cron: a click that overlaps a tick is
                                    answered as skipped, never as a second run. In the split
                                    topology the server names the CronJob to run instead. */}
                                <div className="flex flex-wrap items-start gap-2">
                                    <ActionButton<{ startedAt: string }>
                                        path="/api/admin/osv/sync"
                                        label="Run incremental now"
                                        pendingLabel="Starting…"
                                        describe={() => 'Started — this tab shows the run once it lands'}
                                        onDone={refetch}
                                        title="One incremental cycle, now, in the server process — what the hourly schedule runs"
                                    />
                                    <ActionButton<{ startedAt: string }>
                                        path="/api/admin/osv/bootstrap"
                                        label="Bootstrap if needed"
                                        pendingLabel="Starting…"
                                        describe={() =>
                                            'Started — a no-op if the mirror already carries what is configured'
                                        }
                                        onDone={refetch}
                                        title="Rebuild the mirror from the archives if it is empty or narrower than OSV_ECOSYSTEMS; otherwise nothing"
                                    />
                                </div>
                            </div>
                            <OsvStateCard
                                state={data.state}
                                generations={data.generations}
                                configuredEcosystems={data.configuredEcosystems}
                            />
                        </div>

                        <div className="bg-surface-raised rounded-md border border-edge p-5">
                            <h2 className="text-sm font-semibold text-ink-secondary mb-4 flex items-center gap-2">
                                <FileWarning className="size-4 text-ink-faint" />
                                Ingestion Health
                            </h2>
                            <OsvParseFailuresCard
                                parseFailures={data.parseFailures}
                                validationWarnings={data.validationWarnings}
                                onClear={refetch}
                            />
                        </div>
                    </div>

                    <div className="bg-surface-raised rounded-md border border-edge p-5">
                        <h2 className="text-sm font-semibold text-ink-secondary mb-4">Recent Sync Runs</h2>
                        {data.recentRuns.length === 0 ? (
                            <p className="text-sm text-ink-muted">No sync runs recorded yet.</p>
                        ) : (
                            <TableContainer variant="plain">
                                <Table aria-label="Recent sync runs">
                                    <TableHead>
                                        {/* Paired with the cells in `OsvRunRow` — the
                                            `hideBelow` values must agree. */}
                                        <TableHeader srOnly>Outcome</TableHeader>
                                        <TableHeader>When</TableHeader>
                                        <TableHeader hideBelow="sm">Mode</TableHeader>
                                        <TableHeader align="end" hideBelow="md">
                                            Records
                                        </TableHeader>
                                        <TableHeader align="end" hideBelow="md">
                                            New
                                        </TableHeader>
                                        <TableHeader align="end" hideBelow="md">
                                            Updated
                                        </TableHeader>
                                        <TableHeader align="end" hideBelow="lg">
                                            Unchanged
                                        </TableHeader>
                                        <TableHeader align="end">Errors</TableHeader>
                                        <TableHeader align="end" hideBelow="md">
                                            Lag
                                        </TableHeader>
                                        <TableHeader align="end" hideBelow="lg">
                                            Duration
                                        </TableHeader>
                                    </TableHead>
                                    <TableBody>
                                        {data.recentRuns.map((run) => (
                                            <OsvRunRow key={run.id} run={run} />
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        )}
                    </div>

                    <div className="bg-surface-raised rounded-md border border-edge p-5">
                        <h2 className="text-sm font-semibold text-ink-secondary mb-4 flex items-center gap-2">
                            <FileWarning className="size-4 text-ink-faint" />
                            Sync Failure Records
                        </h2>
                        <ParseFailuresTable refreshKey={reloadKey} />
                    </div>
                </div>
            )}
        </TabShell>
    );
}

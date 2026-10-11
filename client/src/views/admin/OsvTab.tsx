'use client';

import { FileWarning } from 'lucide-react';
import { TableContainer, Table, TableHead, TableBody, TableHeader } from '@/components/ui';
import { useTabData } from './useTabData';
import { TabShell } from './Shared';
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
                            <h2 className="text-sm font-semibold text-ink-secondary mb-4">Mirror State</h2>
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

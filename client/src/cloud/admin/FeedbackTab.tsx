// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, MessageSquareText } from 'lucide-react';
import {
    Spinner,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui';
import { PAGE_SIZE } from '@/lib/constants';
import { useTabData } from '@/views/admin/useTabData';
import { TabShell, SourceTables } from '@/views/admin/Shared';
import { formatTimeAgo } from '@/views/admin/utils';
import type { AdminFeedbackData } from './types';

/**
 * The feedback inbox: everything users sent through the sidebar's
 * "Send feedback" dialog, cross-tenant, newest first. Read-only on purpose —
 * a reply happens over email, and the address is right there in the row.
 */
export function FeedbackTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const [offset, setOffset] = useState(0);

    const url = `/api/admin/feedback?limit=${PAGE_SIZE}&offset=${offset}`;
    const { data, isLoading, error, refetch } = useTabData<AdminFeedbackData>(url, refreshKey, onLoadingChange);

    const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
    const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm text-ink-muted">
                    What users sent through the in-app &ldquo;Send feedback&rdquo; dialog.
                </p>
                <SourceTables tables={['feedback', 'users']} />
            </div>

            <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
                {data && (
                    <>
                        <TableContainer>
                            {data.feedback.length === 0 ? (
                                <div className="py-12 text-center">
                                    <MessageSquareText className="mx-auto size-8 text-ink-faint/70" />
                                    <p className="mt-3 text-sm text-ink-muted">No feedback yet</p>
                                </div>
                            ) : (
                                <Table density="spacious" aria-label="User feedback">
                                    <TableHead>
                                        <TableHeader>User</TableHeader>
                                        <TableHeader>Message</TableHeader>
                                        <TableHeader hideBelow="lg">Page</TableHeader>
                                        <TableHeader align="end" hideBelow="sm">
                                            Sent
                                        </TableHeader>
                                    </TableHead>
                                    <TableBody>
                                        {data.feedback.map((entry) => (
                                            <TableRow key={entry.id}>
                                                <TableCell className="align-top">
                                                    <p className="text-xs sm:text-sm text-ink">
                                                        {entry.userName ?? entry.userEmail}
                                                    </p>
                                                    <p className="text-xs text-ink-muted break-all">
                                                        {entry.userEmail}
                                                    </p>
                                                    {entry.orgName && (
                                                        <p className="mt-0.5 text-xs text-ink-muted">{entry.orgName}</p>
                                                    )}
                                                    {/* Sent rides under the sender on phones, where its column is gone. */}
                                                    <p
                                                        className="sm:hidden mt-0.5 text-xs text-ink-muted"
                                                        title={new Date(entry.createdAt).toLocaleString()}
                                                    >
                                                        {formatTimeAgo(entry.createdAt)}
                                                    </p>
                                                </TableCell>
                                                <TableCell className="align-top w-full">
                                                    <p className="text-xs sm:text-sm text-ink whitespace-pre-wrap break-words max-w-2xl">
                                                        {entry.message}
                                                    </p>
                                                </TableCell>
                                                <TableCell hideBelow="lg" className="align-top">
                                                    {entry.page ? (
                                                        <span className="font-mono text-xs text-ink-muted break-all">
                                                            {entry.page}
                                                        </span>
                                                    ) : (
                                                        <span className="text-xs text-ink-faint">—</span>
                                                    )}
                                                </TableCell>
                                                <TableCell
                                                    align="end"
                                                    hideBelow="sm"
                                                    className="align-top text-ink-muted whitespace-nowrap"
                                                    title={new Date(entry.createdAt).toLocaleString()}
                                                >
                                                    {formatTimeAgo(entry.createdAt)}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </TableContainer>

                        {totalPages > 1 && (
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted">
                                <span>{data.total} messages total</span>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                                        disabled={offset === 0}
                                        className="p-1.5 rounded-sm hover:bg-surface-hover disabled:opacity-40 cursor-pointer disabled:cursor-default"
                                    >
                                        <ChevronLeft className="size-4" />
                                    </button>
                                    <span className="tabular-nums">
                                        Page {currentPage} of {totalPages}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setOffset(offset + PAGE_SIZE)}
                                        disabled={offset + PAGE_SIZE >= data.total}
                                        className="p-1.5 rounded-sm hover:bg-surface-hover disabled:opacity-40 cursor-pointer disabled:cursor-default"
                                    >
                                        <ChevronRight className="size-4" />
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </TabShell>

            {isLoading && (
                <div className="flex justify-center py-4">
                    <Spinner size="sm" className="text-ink-faint/70" />
                </div>
            )}
        </div>
    );
}

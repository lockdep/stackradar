'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';

/**
 * The centred failed-to-load state: a danger icon in a subtle circle, a bold
 * headline, the error's own message, and optionally a retry button. Each call
 * site keeps its own copy — this owns only the block that was re-typed
 * everywhere.
 */
export function ErrorBlock({
    title,
    message,
    icon,
    onRetry,
    retryLabel = 'Try again',
}: {
    /** The bold line — often "Failed to load <thing>", sometimes the error itself. */
    title: string;
    /** The muted line under it, usually the error message. */
    message?: string | null;
    /** Replaces the default TriangleAlert; render it `size-6 text-danger`. */
    icon?: React.ReactNode;
    /** Renders the retry button when given. */
    onRetry?: () => void;
    retryLabel?: string;
}) {
    return (
        <div className="flex items-center justify-center py-24">
            <div className="flex flex-col items-center gap-3">
                <div className="rounded-full bg-danger-subtle p-3">
                    {icon ?? <TriangleAlert className="size-6 text-danger" />}
                </div>
                <p className="text-sm text-ink font-medium">{title}</p>
                {message && <p className="text-sm text-ink-muted">{message}</p>}
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-surface shadow-resting hover:bg-ink/85 cursor-pointer"
                    >
                        <RefreshCw className="size-3.5" />
                        {retryLabel}
                    </button>
                )}
            </div>
        </div>
    );
}

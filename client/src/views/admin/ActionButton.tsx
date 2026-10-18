'use client';

import { useState } from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui';
import type { ButtonVariant } from '@/components/ui/Button';
import { runAdminAction, type Describe } from './actions';

/**
 * A button that POSTs one admin action and says what happened under
 * itself: the server's count, or its refusal. Every action is admin-only
 * and idempotent on the server (`services/admin-actions.service.ts`), so
 * the button needs no confirmation step — a second click while the first
 * is in flight is disabled here and refused there.
 *
 * `onDone` reloads the tab's data, so a retried job or a collected image
 * disappears from the table it was clicked in.
 */
export function ActionButton<T = unknown>({
    path,
    label,
    pendingLabel,
    describe,
    onDone,
    variant = 'secondary',
    title,
}: {
    path: string;
    label: string;
    pendingLabel?: string;
    describe: Describe<T>;
    onDone?: () => void;
    variant?: ButtonVariant;
    /** The hover sentence: what the click does and where it runs. */
    title?: string;
}) {
    const [pending, setPending] = useState(false);
    const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

    async function run() {
        setPending(true);
        setOutcome(null);
        const result = await runAdminAction<T>(path, describe);
        setOutcome(result);
        setPending(false);
        if (result.ok) onDone?.();
    }

    return (
        <span className="inline-flex flex-col items-start gap-1">
            <Button size="sm" variant={variant} loading={pending} onClick={run} title={title}>
                {pending ? (pendingLabel ?? label) : label}
            </Button>
            {outcome && (
                <span
                    role="status"
                    className={`text-xs flex items-start gap-1 max-w-xs ${outcome.ok ? 'text-success' : 'text-attention'}`}
                >
                    {outcome.ok ? (
                        <CheckCircle className="size-3.5 shrink-0 mt-px" aria-hidden="true" />
                    ) : (
                        <AlertCircle className="size-3.5 shrink-0 mt-px" aria-hidden="true" />
                    )}
                    {outcome.message}
                </span>
            )}
        </span>
    );
}

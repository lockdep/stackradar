import { ApiError, apiFetch } from '@/lib/api-client';

/**
 * The outcome of one admin action, as a sentence the button can show in
 * place of itself for a moment. The server's three refusals each mean
 * something different to the person clicking: `in_progress` is "wait",
 * `not_available_in_split` is "do it with kubectl, here is the name", and
 * `disabled` is "this install switched it off". Anything else is the
 * server's message, or the status when it sent none.
 */
export interface ActionOutcome {
    ok: boolean;
    message: string;
}

/** What a successful response says, given its body. The caller knows the shape. */
export type Describe<T> = (body: T) => string;

export async function runAdminAction<T = unknown>(path: string, describe: Describe<T>): Promise<ActionOutcome> {
    try {
        const body = await apiFetch<T>(path, { method: 'POST' });
        return { ok: true, message: describe(body) };
    } catch (err) {
        return { ok: false, message: describeActionError(err) };
    }
}

export function describeActionError(err: unknown): string {
    if (err instanceof ApiError) {
        const code = (err.body as { code?: unknown } | undefined)?.code;
        if (code === 'in_progress') return 'Already running — the next run can start once it finishes.';
        if (err.status === 409 || err.status === 404) return err.message;
        if (err.status === 0) return 'Could not reach the server.';
        return `The server answered ${err.status}: ${err.message}`;
    }
    return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

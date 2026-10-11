import { reloadIfSessionLost } from '@/lib/session-lost';

/**
 * The one way the browser talks to the BFF outside `useResource` /
 * `usePagedResource`: mutations, one-shot reads inside an event handler, and
 * the few fetch-into-state effects that are not a resource.
 *
 * Every call checks `res.ok`, reads the API's `{ error }` envelope and throws
 * an `ApiError`, so a caller can only ever see a parsed body or a typed
 * failure. The audit that produced this file found ~90 raw `fetch()` sites
 * in ~40 files; a third read `res.json()` without looking at the status, so
 * an expired session or a 500 landed in state as `{ error: "…" }` and
 * rendered as data. The alternative — a per-site `if (!res.ok)` — is what
 * had drifted.
 *
 * A 401 is handled here as the hooks handle it (`reloadIfSessionLost`): the
 * session behind the page is gone and nothing can load until the browser
 * goes back through the middleware. When the reload has been issued the
 * returned promise never settles — there is no state worth setting on a
 * page that is being torn down — which is the hooks' silent `return`, as a
 * promise. Sign-in itself answers 401 for a wrong password; it passes
 * `on401: 'throw'`.
 *
 * Streaming and download semantics (the SBOM document) are not this
 * function's: they are plain `<a href>` or `fetch` and say so at the site.
 */

export type ApiFetchInit = Omit<RequestInit, 'body'> & {
    /** A JSON body: serialised, with `Content-Type: application/json` set. */
    json?: unknown;
    /** A body passed through untouched (multipart, text). */
    body?: BodyInit | null;
    /**
     * `reload` (default): a 401 means the session is gone — check and reload.
     * `throw`: a 401 is this request's own answer (sign-in), surfaced as an `ApiError`.
     */
    on401?: 'reload' | 'throw';
};

export class ApiError extends Error {
    /** HTTP status; `0` when the request never reached the server. */
    readonly status: number;
    /** The parsed response body, when there was one — `{ error, … }` from the API. */
    readonly body: unknown;

    constructor(status: number, message: string, body?: unknown, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

/** The API's message for a failed response, or the status when it sent none. */
function messageOf(status: number, body: unknown): string {
    if (body && typeof body === 'object') {
        const { error, message } = body as { error?: unknown; message?: unknown };
        if (typeof error === 'string' && error) return error;
        if (typeof message === 'string' && message) return message;
    }
    return `HTTP ${status}`;
}

/** Never settles: the page is reloading and nothing after this should run. */
const never = new Promise<never>(() => {});

/**
 * `fetch` against the BFF, resolved to the parsed JSON body (or `undefined`
 * for an empty 2xx such as 204). Rejects with `ApiError` for a non-2xx
 * response and for a network failure; an `AbortError` passes through
 * untouched so callers that cancel can keep ignoring it.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiFetchInit = {}): Promise<T> {
    const { json, on401 = 'reload', headers, ...rest } = init;
    const request: RequestInit = { ...rest };
    if (json !== undefined) {
        request.body = JSON.stringify(json);
        request.headers = { 'Content-Type': 'application/json', ...headersToObject(headers) };
    } else if (headers) {
        request.headers = headers;
    }

    let res: Response;
    try {
        res = await fetch(path, request);
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        throw new ApiError(0, 'Could not reach the server', undefined, { cause: err });
    }

    if (res.status === 401 && on401 === 'reload' && (await reloadIfSessionLost())) return never;

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw new ApiError(res.status, messageOf(res.status, body), body);
    return body as T;
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return headers;
}

/** The message to show for anything a call may throw — an `ApiError`, an `Error`, or neither. */
export function errorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message) return err.message;
    return fallback;
}

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createApiHeaders, getExpressUrl, handleApiError, getRequestId } from '@/lib/api-utils';
import { createLogger } from '@/lib/logger';

/**
 * Catch-all BFF proxy.
 *
 * Every `/api/*` request that is not handled by a more specific route file
 * (Next.js routes static segments first: `auth/[...nextauth]`, `health/*`,
 * `users/setup`) is authenticated here and forwarded verbatim to the Express
 * backend at the same path — method, query string, body and Content-Type all
 * pass through, and the Express response streams back untouched. The BFF's
 * job is authentication and org-context resolution (`createApiHeaders`), not
 * per-route logic; Express owns validation and authorization beyond the two
 * gates below.
 *
 * Gates:
 * - No session -> 401 `{ error }` (never forwarded).
 * - `admin/*` requires `session.user.isAdmin` -> 403 `{ error }` otherwise.
 *   Express independently enforces this via `requireAdmin` on the
 *   `X-Is-Admin` header that `createApiHeaders` only sets for admins; the
 *   BFF gate exists so non-admin traffic is rejected before leaving the pod,
 *   matching the previous per-route admin handlers.
 */

const log = createLogger('api.proxy');

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext): Promise<NextResponse> {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { path } = await context.params;

    if (path[0] === 'admin' && !session.user.isAdmin) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const reqId = getRequestId(request);
    // Params arrive decoded; re-encode each segment so ids containing
    // reserved characters survive the round trip.
    const targetPath = `/api/${path.map(encodeURIComponent).join('/')}`;
    const url = `${getExpressUrl()}${targetPath}${request.nextUrl.search}`;
    const method = request.method;

    try {
        const headers: Record<string, string> = {
            ...(await createApiHeaders(session, request)),
            'X-Request-Id': reqId,
        };

        const init: RequestInit & { duplex?: 'half' } = {
            method,
            headers,
            cache: 'no-store',
        };

        if (method !== 'GET' && method !== 'HEAD') {
            // Stream the body through untouched; preserve the caller's
            // Content-Type (createApiHeaders defaults it to application/json).
            init.body = request.body;
            init.duplex = 'half';
            const contentType = request.headers.get('content-type');
            if (contentType) {
                headers['Content-Type'] = contentType;
            }
        }

        const response = await fetch(url, init);

        log.info(
            {
                reqId,
                method,
                path: targetPath,
                status: response.status,
                userId: session.user.id,
            },
            'Proxied to Express',
        );

        const responseHeaders: Record<string, string> = {
            'Content-Type': response.headers.get('content-type') ?? 'application/json',
        };
        // The one non-JSON-envelope response Express sends: an SBOM document
        // asked for as a download (`GET /api/sboms/:id/document?download=1`).
        // Without this the browser renders the file instead of saving it.
        const disposition = response.headers.get('content-disposition');
        if (disposition) {
            responseHeaders['Content-Disposition'] = disposition;
        }

        return new NextResponse(response.body, {
            status: response.status,
            headers: responseHeaders,
        });
    } catch (error) {
        return handleApiError(error, reqId);
    }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { isDemoMode } from '@/lib/demo';

// /invite and /api/invites are public: the invite acceptance page handles
// both signed-in and signed-out states itself (signed-out users get sign-in
// buttons that round-trip back to the invite).
//
// /terms and /privacy redirect to the marketing site from next.config.ts.
// Those redirects already run before this proxy, so these entries only matter
// if the redirects are ever removed — but a legal page behind a login is the
// exact failure worth one line of insurance against.
// "/ingest" is the PostHog reverse proxy (see next.config.ts) — capture calls
// carry no session and must not bounce to /login.
// "/demo" is `/demo/enter`, the live demo's no-account sign-in
// It 404s unless DEMO_MODE is set, so listing it here costs production
// nothing.
// "/api/auth" covers Auth.js and `/api/auth/local`, the password sign-in,
// which 404s unless local login is enabled.
const publicRoutes = [
    '/login',
    '/api/auth',
    '/api/health',
    '/invite',
    '/api/invites',
    '/terms',
    '/privacy',
    '/ingest',
    '/demo',
];

/**
 * What a session that must change its password may still reach: the page
 * that changes it, the route the page calls, sign-out, and the probes.
 * Everything else redirects there (pages) or is refused (API), so a
 * bootstrap or admin-set password is used exactly once — to replace itself.
 */
const passwordChangeRoutes = ['/account/password', '/api/account/password', '/api/auth', '/api/health'];
export const PASSWORD_CHANGE_REQUIRED_CODE = 'password_change_required';

/**
 * Demo-mode response headers. `X-Robots-Tag` belongs in `next.config.ts`
 * `headers()` by convention, but that list is fixed at build time and the
 * demo runs the production image with a runtime env — so it is set here,
 * where the env is read per request. `robots.ts` and the layout's robots
 * metadata already disallow and `noindex` the whole app; this is the
 * header form of the same answer, for the crawlers that read headers first.
 */
function withDemoHeaders(response: NextResponse): NextResponse {
    if (isDemoMode()) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
}

function matches(pathname: string, routes: string[]): boolean {
    return routes.some((route) => pathname === route || pathname.startsWith(route + '/'));
}

export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    const isPublicRoute = matches(pathname, publicRoutes);

    const session = await auth();
    const isLoggedIn = !!session?.user;

    // The demo has no sign-in page: anyone arriving at /login — a sign-out,
    // an expired demo session, a typed URL — goes straight through the
    // demo's door instead. `callbackUrl` is deliberately not carried: the
    // demo always lands on `/`.
    if (!isLoggedIn && isDemoMode() && pathname === '/login') {
        return withDemoHeaders(NextResponse.redirect(new URL('/demo/enter', request.url)));
    }

    if (!isLoggedIn && !isPublicRoute) {
        // An API call with no session gets a 401, never a redirect. `fetch`
        // follows redirects, so the sign-in page — or, in demo mode, the
        // `/demo/enter` → `/` chain, minting a session per in-flight request —
        // would come back as a 200 HTML body where the caller expected JSON.
        // The catch-all route answers the same way; this keeps the two in step.
        if (pathname.startsWith('/api/')) {
            return withDemoHeaders(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
        }
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('callbackUrl', pathname);
        return withDemoHeaders(NextResponse.redirect(loginUrl));
    }

    if (isLoggedIn && pathname === '/login') {
        // Honor a same-origin relative callbackUrl (e.g. an invite link) so
        // already-signed-in users land where the link intended.
        const callbackUrl = request.nextUrl.searchParams.get('callbackUrl');
        const target = callbackUrl && callbackUrl.startsWith('/') && !callbackUrl.startsWith('//') ? callbackUrl : '/';
        return withDemoHeaders(NextResponse.redirect(new URL(target, request.url)));
    }

    // A password that must be changed is the only thing this session may do.
    // Same shape as the signed-out branch: redirect a page, refuse an API
    // call with JSON the caller can read (the `code` is what the UI matches).
    if (isLoggedIn && session.user.mustChangePassword && !matches(pathname, passwordChangeRoutes)) {
        if (pathname.startsWith('/api/')) {
            return withDemoHeaders(
                NextResponse.json(
                    { error: 'Password change required', code: PASSWORD_CHANGE_REQUIRED_CODE },
                    { status: 403 },
                ),
            );
        }
        return withDemoHeaders(NextResponse.redirect(new URL('/account/password', request.url)));
    }

    return withDemoHeaders(NextResponse.next());
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - icon / apple-icon (the generated app icons — see below)
         * - public folder assets
         *
         * The icon routes have to be listed by name. They are generated by
         * `src/app/icon.tsx` and `src/app/apple-icon.tsx`, so unlike every other
         * image on the site they have no file extension and the `.png$` clause
         * below does not cover them. Left in, they are auth-gated: a signed-out
         * visitor on /login requests /icon, gets redirected to /login, and the tab
         * shows no icon at all — on the one page every signed-out user sees.
         * `$`-anchored so this exempts /icon exactly and not, say, /icons.
         */
        '/((?!_next/static|_next/image|favicon.ico|icon$|apple-icon$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};

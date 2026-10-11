// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { DEMO_SESSION_MAX_AGE_SECONDS, isDemoMode } from '@/lib/demo';
import { demoUserEmail } from './hosted';
import { clientIp, issueSession, setSessionCookie, sweepExpiredSessions } from '@/lib/local-session';
import { TokenBucket } from '@/lib/rate-limit';
import { createLogger } from '@/lib/logger';

/**
 * The demo's front door.
 *
 * `GET /demo/enter` signs the visitor in as the demo user without an OAuth
 * round trip: it writes an Auth.js `sessions` row itself and sets the cookie
 * Auth.js will read it back from (`lib/local-session.ts`, which local
 * password sign-in shares). Everything after that is the ordinary app with
 * an ordinary database session; the server refuses writes because the user
 * and org are flagged `demo`, not because of anything here.
 *
 * 404 outside demo mode — the route does not exist on app.stackradar.io.
 */

const log = createLogger('demo.enter');

/**
 * Ten entries a minute per address. In memory: the demo client runs one
 * replica, so there is no
 * second pod to disagree with.
 */
const limiter = new TokenBucket(10, 60_000);

export async function GET(request: NextRequest) {
    if (!isDemoMode()) {
        return new NextResponse(null, { status: 404 });
    }

    const now = Date.now();
    if (!limiter.take(clientIp(request), now)) {
        return NextResponse.json(
            { error: 'Too many requests' },
            { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
        );
    }

    const email = demoUserEmail();
    const user = await db.query.users.findFirst({
        columns: { id: true, demo: true },
        where: eq(users.email, email),
    });
    if (!user || !user.demo) {
        // The demo seed creates this row with `demo = true`; a real
        // account at this address must never be handed out.
        log.error({ email, found: Boolean(user) }, 'demo user missing or not flagged demo — was the seed run?');
        return NextResponse.json(
            { error: 'The demo is not set up' },
            { status: 500, headers: { 'Cache-Control': 'no-store' } },
        );
    }

    const session = await issueSession(user.id, DEMO_SESSION_MAX_AGE_SECONDS, now);
    sweepExpiredSessions(now);

    // A relative `Location`, not `new URL("/", request.url)`: behind the
    // ingress `request.url` is the address the standalone server listens on
    // (`https://0.0.0.0:3000/`),
    // and `NextResponse.redirect` insists on an absolute URL. The browser
    // resolves `/` against the host it asked, which is the only host we want.
    const response = new NextResponse(null, { status: 302, headers: { Location: '/' } });
    setSessionCookie(response, request, session);
    return response;
}

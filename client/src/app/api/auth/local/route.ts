import { NextResponse, type NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import {
    LOCAL_SESSION_MAX_AGE_SECONDS,
    LOCKOUT_MS,
    LOCKOUT_THRESHOLD,
    PASSWORD_MAX_LENGTH,
    SIGN_IN_FAILED_MESSAGE,
    isLocalLoginEnabled,
} from '@/lib/local-login';
import { clientIp, issueSession, setSessionCookie, sweepExpiredSessions } from '@/lib/local-session';
import { verifyAgainstNothing, verifyPassword } from '@/lib/password';
import { TokenBucket } from '@/lib/rate-limit';
import { createLogger } from '@/lib/logger';

/**
 * `POST /api/auth/local` — username/password sign-in. A static segment under `/api/auth`, so it wins over the
 * Auth.js catch-all; `proxy.ts` lists `/api/auth` as public.
 *
 * On success it writes the Auth.js session row and cookie exactly as the
 * demo's door does (`lib/local-session.ts`) and answers with where to go:
 * `/account/password` while the account must change its password, the
 * caller's same-origin `callbackUrl` otherwise. The browser form follows it.
 *
 * Every failure — unknown email, provider-only account, locked account,
 * wrong password — is the same `401`, the same body and one argon2
 * verification, so the response tells an attacker nothing about which
 * part was wrong (`verifyAgainstNothing`). Five failures lock the account
 * for fifteen minutes; the lock is per account, the rate limit per address.
 *
 * 404 when local login is off — the route does not exist on app.stackradar.io.
 */

const log = createLogger('auth.local');

/**
 * Ten attempts a minute per address, in memory. The community client is one
 * pod; a split topology with several replicas needs the limit at the
 * ingress (document this in the chart), because these buckets are per process.
 */
const limiter = new TokenBucket(10, 60_000);

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function failed(): NextResponse {
    return NextResponse.json({ error: SIGN_IN_FAILED_MESSAGE }, { status: 401, headers: NO_STORE });
}

function safeCallbackUrl(raw: unknown): string {
    return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export async function POST(request: NextRequest) {
    if (!isLocalLoginEnabled()) {
        return new NextResponse(null, { status: 404 });
    }

    const now = Date.now();
    if (!limiter.take(clientIp(request), now)) {
        return NextResponse.json(
            { error: 'Too many sign-in attempts. Try again in a minute.' },
            { status: 429, headers: { 'Retry-After': '60', ...NO_STORE } },
        );
    }

    const body = (await request.json().catch(() => null)) as {
        email?: unknown;
        password?: unknown;
        callbackUrl?: unknown;
    } | null;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 255 || password.length > PASSWORD_MAX_LENGTH) {
        return NextResponse.json({ error: 'Email and password are required.' }, { status: 400, headers: NO_STORE });
    }

    const user = await db.query.users.findFirst({
        columns: {
            id: true,
            passwordHash: true,
            failedLogins: true,
            lockedUntil: true,
            mustChangePassword: true,
            demo: true,
        },
        where: sql`LOWER(${users.email}) = ${email.toLowerCase()}`,
    });

    // No hash to check (unknown address, a GitHub/Google/OIDC account, the
    // demo visitor) or a live lock: do the work anyway, then refuse.
    const locked = user?.lockedUntil != null && user.lockedUntil.getTime() > now;
    if (!user?.passwordHash || user.demo || locked) {
        await verifyAgainstNothing(password);
        if (locked) log.info({ userId: user!.id }, 'local sign-in refused: account locked');
        return failed();
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
        const count = user.failedLogins + 1;
        const lock = count >= LOCKOUT_THRESHOLD;
        await db
            .update(users)
            .set(lock ? { failedLogins: 0, lockedUntil: new Date(now + LOCKOUT_MS) } : { failedLogins: count })
            .where(eq(users.id, user.id));
        if (lock)
            log.warn(
                { userId: user.id, lockMinutes: LOCKOUT_MS / 60_000 },
                'local sign-in: account locked after repeated failures',
            );
        return failed();
    }

    if (user.failedLogins > 0 || user.lockedUntil) {
        await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
    }

    const session = await issueSession(user.id, LOCAL_SESSION_MAX_AGE_SECONDS, now);
    sweepExpiredSessions(now);

    const redirectTo = user.mustChangePassword ? '/account/password' : safeCallbackUrl(body?.callbackUrl);
    const response = NextResponse.json({ ok: true, redirectTo }, { status: 200, headers: NO_STORE });
    setSessionCookie(response, request, session);
    log.info({ userId: user.id, mustChangePassword: user.mustChangePassword }, 'local sign-in');
    return response;
}

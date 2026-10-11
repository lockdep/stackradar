import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/db';
import { sessions, users } from '@/db/schema';
import { PASSWORD_MAX_LENGTH, isLocalLoginEnabled, passwordPolicyProblem } from '@/lib/local-login';
import { sessionCookieName } from '@/lib/local-session';
import { hashPassword, verifyPassword } from '@/lib/password';
import { createLogger } from '@/lib/logger';

/**
 * `GET /api/account/password` — whether the signed-in account has a password
 * at all, and whether it must change it. `POST` — change it, with the
 * current one. Not proxied to Express: the
 * hash lives in the client's `users` table and never leaves this process.
 *
 * A successful change clears `must_change_password`, resets the lockout
 * counters and revokes every *other* session of the account, so a password
 * changed because it leaked also ends whatever the leak was being used for.
 * The session doing the changing stays.
 *
 * `proxy.ts` lets a `must_change_password` session reach exactly this route
 * and the page that calls it.
 */

const log = createLogger('account.password');
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET() {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isLocalLoginEnabled()) {
        return new NextResponse(null, { status: 404 });
    }
    const user = await db.query.users.findFirst({
        columns: { passwordHash: true, mustChangePassword: true },
        where: eq(users.id, session.user.id),
    });
    return NextResponse.json(
        { hasPassword: Boolean(user?.passwordHash), mustChangePassword: user?.mustChangePassword ?? false },
        { headers: NO_STORE },
    );
}

export async function POST(request: NextRequest) {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isLocalLoginEnabled()) {
        return new NextResponse(null, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
        currentPassword?: unknown;
        newPassword?: unknown;
    } | null;
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || !newPassword || currentPassword.length > PASSWORD_MAX_LENGTH) {
        return NextResponse.json(
            { error: 'Current and new password are required.' },
            { status: 400, headers: NO_STORE },
        );
    }
    const problem = passwordPolicyProblem(newPassword);
    if (problem) {
        return NextResponse.json({ error: problem }, { status: 400, headers: NO_STORE });
    }
    if (newPassword === currentPassword) {
        return NextResponse.json(
            { error: 'The new password must differ from the current one.' },
            { status: 400, headers: NO_STORE },
        );
    }

    const user = await db.query.users.findFirst({
        columns: { id: true, passwordHash: true },
        where: eq(users.id, session.user.id),
    });
    if (!user?.passwordHash) {
        // A GitHub/Google/OIDC account: there is nothing to change here.
        return NextResponse.json(
            { error: 'This account signs in through an identity provider and has no password.' },
            { status: 400, headers: NO_STORE },
        );
    }
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        return NextResponse.json({ error: 'The current password is incorrect.' }, { status: 403, headers: NO_STORE });
    }

    const passwordHash = await hashPassword(newPassword);
    await db
        .update(users)
        .set({ passwordHash, mustChangePassword: false, failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));

    // Revoke the account's other sessions; keep the one that just proved
    // it knows the (old) password.
    const current = request.cookies.get(sessionCookieName(request))?.value;
    await db
        .delete(sessions)
        .where(
            current
                ? and(eq(sessions.userId, user.id), ne(sessions.sessionToken, current))
                : eq(sessions.userId, user.id),
        );

    log.info({ userId: user.id }, 'password changed');
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

import { NextResponse, type NextRequest } from 'next/server';
import { and, count, eq, ne } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/db';
import { users } from '@/db/schema';
import { isLocalLoginEnabled } from '@/lib/local-login';
import { createLogger } from '@/lib/logger';

/**
 * `PATCH /api/admin/users/:id` — grant or revoke the platform-admin flag on
 * an existing account, whatever way it signs in. `auth.users.is_admin` is
 * this app's column, so the route is explicit like the rest of `admin/users`.
 *
 * Two refusals, both so an install cannot lock itself out of its own
 * administration: the last admin cannot be revoked, and the demo account
 * cannot be granted. A revoke takes effect on the account's next request —
 * the session reads the row each time — so no session is deleted here.
 *
 * With `AUTH_OIDC_ADMIN_GROUP` set, a grant to a group-managed account is
 * overwritten at that account's next OIDC sign-in; the Users tab says so
 * next to the button, and the route does not second-guess the admin.
 */

const log = createLogger('admin.users.admin-flag');
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!session.user.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!isLocalLoginEnabled()) return new NextResponse(null, { status: 404 });

    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { isAdmin?: unknown } | null;
    if (typeof body?.isAdmin !== 'boolean') {
        return NextResponse.json({ error: 'isAdmin must be true or false.' }, { status: 400, headers: NO_STORE });
    }
    const isAdmin = body.isAdmin;

    const user = await db.query.users.findFirst({
        columns: { id: true, isAdmin: true, demo: true },
        where: eq(users.id, id),
    });
    if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404, headers: NO_STORE });
    if (user.demo && isAdmin) {
        return NextResponse.json(
            { error: 'The demo account cannot be a platform admin.' },
            { status: 403, headers: NO_STORE },
        );
    }
    if (user.isAdmin === isAdmin) {
        return NextResponse.json({ id: user.id, isAdmin }, { headers: NO_STORE });
    }

    if (!isAdmin) {
        const [row] = await db
            .select({ n: count() })
            .from(users)
            .where(and(eq(users.isAdmin, true), ne(users.id, user.id)));
        if (Number(row?.n ?? 0) === 0) {
            return NextResponse.json(
                { error: 'This is the last platform admin; grant another account first.' },
                { status: 409, headers: NO_STORE },
            );
        }
    }

    await db.update(users).set({ isAdmin, updatedAt: new Date() }).where(eq(users.id, user.id));
    log.info(
        { userId: user.id, isAdmin, by: session.user.id },
        isAdmin ? 'platform admin granted' : 'platform admin revoked',
    );
    return NextResponse.json({ id: user.id, isAdmin }, { headers: NO_STORE });
}

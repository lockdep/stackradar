import { NextResponse, type NextRequest } from 'next/server';
import { asc, sql } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/db';
import { accounts, users } from '@/db/schema';
import { isLocalLoginEnabled, passwordPolicyProblem } from '@/lib/local-login';
import { hashPassword } from '@/lib/password';
import { createLogger } from '@/lib/logger';

/**
 * The admin dashboard's Users tab. Its
 * upstream is the client's own `users` table — the one that knows how each
 * account signs in — not Express, so this is an explicit route rather than
 * the catch-all proxy. Same gate as the catch-all applies to `admin/*`:
 * a session, and `isAdmin` on it.
 *
 * `GET` lists every account with how it signs in. `POST` creates a local
 * account with a password the admin hands over out of band; the account
 * must change it at first sign-in. Both 404 when local login is off: the
 * tab exists for local accounts, and the cloud has none.
 */

const log = createLogger('admin.users');
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export interface AdminUserRow {
    id: string;
    email: string;
    name: string | null;
    isAdmin: boolean;
    demo: boolean;
    /** `password` when the account has a hash, then every linked provider id. */
    signIn: string[];
    mustChangePassword: boolean;
    /** ISO timestamp while a lock is in force, else null. */
    lockedUntil: string | null;
    createdAt: string;
}

async function gate(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!session.user.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (!isLocalLoginEnabled()) return new NextResponse(null, { status: 404 });
    return null;
}

export async function GET() {
    const refused = await gate();
    if (refused) return refused;

    const [rows, links] = await Promise.all([
        db
            .select({
                id: users.id,
                email: users.email,
                name: users.name,
                isAdmin: users.isAdmin,
                demo: users.demo,
                hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
                mustChangePassword: users.mustChangePassword,
                lockedUntil: users.lockedUntil,
                createdAt: users.createdAt,
            })
            .from(users)
            .orderBy(asc(users.createdAt))
            .limit(1000),
        db.select({ userId: accounts.userId, provider: accounts.provider }).from(accounts),
    ]);

    const providersByUser = new Map<string, string[]>();
    for (const { userId, provider } of links) {
        const list = providersByUser.get(userId) ?? [];
        if (!list.includes(provider)) list.push(provider);
        providersByUser.set(userId, list);
    }

    const now = Date.now();
    const result: AdminUserRow[] = rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        isAdmin: row.isAdmin,
        demo: row.demo,
        signIn: [...(row.hasPassword ? ['password'] : []), ...(providersByUser.get(row.id) ?? []).sort()],
        mustChangePassword: row.mustChangePassword,
        lockedUntil: row.lockedUntil && row.lockedUntil.getTime() > now ? row.lockedUntil.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
    }));
    return NextResponse.json(
        {
            users: result,
            // With `AUTH_OIDC_ADMIN_GROUP` set, the flag is re-evaluated at every
            // OIDC sign-in, so a grant made here to a group-managed account does
            // not survive that account's next login. The tab says so.
            oidcAdminGroup: Boolean(process.env.AUTH_OIDC_ADMIN_GROUP?.trim()),
        },
        { headers: NO_STORE },
    );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
    const refused = await gate();
    if (refused) return refused;

    const body = (await request.json().catch(() => null)) as {
        email?: unknown;
        name?: unknown;
        password?: unknown;
        isAdmin?: unknown;
    } | null;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 255) : null;
    const password = typeof body?.password === 'string' ? body.password : '';
    const isAdmin = body?.isAdmin === true;

    if (!email || email.length > 255 || !EMAIL.test(email)) {
        return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400, headers: NO_STORE });
    }
    const problem = passwordPolicyProblem(password);
    if (problem) {
        return NextResponse.json({ error: problem }, { status: 400, headers: NO_STORE });
    }

    const taken = await db.query.users.findFirst({
        columns: { id: true },
        where: sql`LOWER(${users.email}) = ${email.toLowerCase()}`,
    });
    if (taken) {
        return NextResponse.json(
            { error: 'A user with that email already exists.' },
            { status: 409, headers: NO_STORE },
        );
    }

    const passwordHash = await hashPassword(password);
    let created: { id: string };
    try {
        [created] = await db
            .insert(users)
            .values({ email, name, emailVerified: new Date(), isAdmin, passwordHash, mustChangePassword: true })
            .returning({ id: users.id });
    } catch (err) {
        if ((err as { code?: unknown })?.code === '23505') {
            return NextResponse.json(
                { error: 'A user with that email already exists.' },
                { status: 409, headers: NO_STORE },
            );
        }
        throw err;
    }

    log.info({ userId: created!.id, isAdmin }, 'local user created by admin');
    return NextResponse.json({ ok: true, id: created!.id }, { status: 201, headers: NO_STORE });
}

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { isLocalLoginEnabled, passwordPolicyProblem } from "@/lib/local-login";
import { hashPassword } from "@/lib/password";
import { createLogger } from "@/lib/logger";

/**
 * `PUT /api/admin/users/:id/password` — an admin sets or resets a local
 * account's password (open-source plan step 04 §4): the hash is replaced,
 * the account must change it at its next sign-in, any lock is lifted and
 * every session it has is revoked — an admin reset is a recovery, and a
 * recovered account should not stay signed in wherever it was.
 *
 * Only accounts that already have a password: giving a GitHub/Google/OIDC
 * account one would add a way in that its owner did not choose. The CLI
 * (`pnpm admin:reset-password --create-local`) does that on purpose.
 */

const log = createLogger("admin.users.password");
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!session.user.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!isLocalLoginEnabled()) return new NextResponse(null, { status: 404 });

    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof body?.password === "string" ? body.password : "";
    const problem = passwordPolicyProblem(password);
    if (problem) {
        return NextResponse.json({ error: problem }, { status: 400, headers: NO_STORE });
    }

    const user = await db.query.users.findFirst({
        columns: { id: true, passwordHash: true, demo: true },
        where: eq(users.id, id),
    });
    if (!user) return NextResponse.json({ error: "User not found." }, { status: 404, headers: NO_STORE });
    if (user.demo) return NextResponse.json({ error: "The demo account has no password." }, { status: 403, headers: NO_STORE });
    if (!user.passwordHash) {
        return NextResponse.json(
            { error: "This account signs in through an identity provider; it has no password to reset." },
            { status: 400, headers: NO_STORE },
        );
    }

    const passwordHash = await hashPassword(password);
    await db
        .update(users)
        .set({ passwordHash, mustChangePassword: true, failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    await db.delete(sessions).where(eq(sessions.userId, user.id));

    log.info({ userId: user.id, by: session.user.id }, "password reset by admin");
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

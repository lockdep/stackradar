import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { isLocalLoginEnabled } from "@/lib/local-login";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata: Metadata = { title: "Password - StackRadar" };

/**
 * Change the signed-in account's password (open-source plan step 04 §3–4).
 * Outside the app shell on purpose: while `must_change_password` is set
 * this is the only page the session may reach (`proxy.ts`), and a sidebar
 * full of links that all bounce back here would be a page that lies.
 * Reached voluntarily from the profile page otherwise.
 *
 * `proxy.ts` has already sent a signed-out visitor to `/login`; the row read
 * here decides which of the three states to draw: forced change, voluntary
 * change, or a provider-only account with no password to change.
 */
export default async function PasswordPage() {
    if (!isLocalLoginEnabled()) notFound();
    const session = await auth();
    if (!session?.user) notFound();

    const user = await db.query.users.findFirst({
        columns: { passwordHash: true, mustChangePassword: true, email: true },
        where: eq(users.id, session.user.id),
    });
    const hasPassword = Boolean(user?.passwordHash);
    const mustChange = user?.mustChangePassword ?? false;

    return (
        <div className="min-h-screen bg-surface flex flex-col">
            <div className="px-6 py-6 lg:px-10">
                <span className="inline-flex items-center gap-2 p-1.5 -m-1.5">
                    <span className="inline-flex size-2 rounded-full bg-accent" aria-hidden="true" />
                    <span className="text-xl font-semibold text-ink tracking-tight">StackRadar</span>
                </span>
            </div>

            <div className="flex flex-1 items-center px-6 pb-16 lg:px-10">
                <div className="mx-auto w-full max-w-sm">
                    {hasPassword ? (
                        <>
                            <h1 className="text-balance text-[1.75rem] font-semibold leading-tight tracking-tight text-ink">
                                {mustChange ? "Choose a new password" : "Change your password"}
                            </h1>
                            <p className="mt-3 text-base text-ink-muted">
                                {mustChange
                                    ? "The password you signed in with was set for you. Replace it before going on; nothing else is reachable until you do."
                                    : <>Signed in as <span className="text-ink">{user?.email}</span>.</>}
                            </p>
                            <ChangePasswordForm mustChange={mustChange} />
                        </>
                    ) : (
                        <>
                            <h1 className="text-balance text-[1.75rem] font-semibold leading-tight tracking-tight text-ink">
                                No password to change
                            </h1>
                            <p className="mt-3 text-base text-ink-muted">
                                This account signs in through an identity provider, so its password lives there, not here.
                            </p>
                        </>
                    )}

                    {!mustChange && (
                        <p className="mt-8 text-sm text-ink-muted">
                            <Link href="/profile" className="font-medium text-accent hover:underline">
                                Back to profile
                            </Link>
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

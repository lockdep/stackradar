import Link from "next/link"
import { auth } from "@/auth"
import { getExpressUrl } from "@/lib/api-utils"
import { AcceptInviteCard } from "./AcceptInviteCard"
import { buttonClasses } from "@/components/ui"

interface InviteDetails {
    email: string
    role: "admin" | "member"
    expiresAt: string
    organization: {
        id: string
        name: string
    }
}

async function fetchInvite(token: string): Promise<InviteDetails | null> {
    try {
        // Public endpoint on the Express server (optionalAuth) — no session needed
        const response = await fetch(`${getExpressUrl()}/api/invites/${token}`, {
            cache: "no-store",
        })
        if (!response.ok) return null
        const data = await response.json()
        return data.invite ?? null
    } catch {
        return null
    }
}



export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params
    const [invite, session] = await Promise.all([fetchInvite(token), auth()])

    return (
        <div className="min-h-screen bg-surface flex flex-col justify-center">
            <div className="sm:mx-auto sm:w-full sm:max-w-md px-6">
                <div className="flex flex-col items-center mb-10">
                    <h1 className="text-3xl font-bold text-ink tracking-tight mb-2">StackRadar</h1>
                </div>

                <div className="bg-surface-raised border border-edge rounded-md p-8 shadow-resting">
                    {!invite ? (
                        <div className="text-center">
                            <h2 className="text-xl font-semibold text-ink mb-2">Invite not found</h2>
                            <p className="text-sm text-ink-secondary mb-6">
                                This invite link is invalid, has expired, or was already used.
                                Ask your organization admin to send a new one.
                            </p>
                            <Link href="/" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
                                Go to StackRadar
                            </Link>
                        </div>
                    ) : !session?.user ? (
                        <>
                            <h2 className="text-xl font-semibold text-ink text-center mb-2">
                                Join {invite.organization.name}
                            </h2>
                            <p className="text-ink-secondary text-center text-sm mb-8">
                                You&apos;ve been invited to join{" "}
                                <span className="font-medium text-ink">{invite.organization.name}</span> as{" "}
                                {invite.role === "admin" ? "an admin" : "a member"}. Sign in to accept.
                            </p>

                            {/* The login page knows every sign-in this install offers —
                                local password, OIDC, GitHub, Google — and which are
                                configured; drawing provider buttons here again is how
                                a community install showed GitHub and Google buttons
                                that 404ed. One door, with the way back. */}
                            <Link
                                href={`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`}
                                className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}
                            >
                                Sign in to accept
                            </Link>
                        </>
                    ) : (
                        <AcceptInviteCard
                            token={token}
                            orgName={invite.organization.name}
                            role={invite.role}
                            inviteEmail={invite.email}
                            sessionEmail={session.user.email ?? ""}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}

import NextAuth from "next-auth"
import GitHub from "next-auth/providers/github"
import Google from "next-auth/providers/google"
import type { OIDCConfig } from "next-auth/providers"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { users, accounts, sessions, verificationTokens } from "@/db/schema"
import { recordAuthError } from "@/lib/auth-health"
import { isProviderEnabled, oidcAdminFromProfile, oidcDisplayName } from "@/lib/auth-providers"
import { DEMO_SESSION_MAX_AGE_SECONDS, isDemoMode } from "@/lib/demo"

/**
 * The claims a generic OIDC issuer sends (OpenID Connect Core 1.0 §5.1),
 * plus whatever the deployment's groups claim is called. Only the standard
 * ones are read by name; the groups claim goes through `oidcAdminFromProfile`.
 */
interface OidcProfile extends Record<string, unknown> {
  sub: string
  name?: string
  preferred_username?: string
  email?: string
  picture?: string
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: {
    strategy: "database", // Allows server-side revocation (logout, account compromise)

    // A 24-hour *idle* window, down from the Auth.js default of 30 days.
    //
    // `maxAge` is sliding, not absolute: Auth.js recomputes `expires` as
    // `now + maxAge` on any read where `expires - maxAge + updateAge` has
    // passed. So someone using StackRadar daily is never interrupted, while an
    // abandoned session — a forgotten tab, a shared machine — dies within a day.
    // Re-authentication is a redirect and one click, since we are OAuth-only.
    //
    // The trade-off of a sliding window is that a stolen cookie stays alive
    // while the attacker keeps using it. Database sessions are the answer to
    // that: they can be revoked server-side, which a JWT could not be.
    //
    // Set `updateAge` equal to `maxAge` if you ever want a hard daily cutoff —
    // the refresh then falls due exactly when the session expires, so it never
    // slides. Say so in a comment if you do; it reads as a typo otherwise.
    //
    // The live demo (`docs/live-demo/` step 02, `DEMO_MODE=true`) is the
    // one place that takes that option: a demo session is two hours from
    // entry, full stop. `updateAge === maxAge` is deliberate — the refresh
    // falls due exactly at expiry, so the window never slides and a
    // visitor's tab cannot keep the shared demo account alive indefinitely.
    // Re-entry is one redirect through `/demo/enter`.
    //
    // Sessions minted outside Auth.js — the demo's, and local password
    // sign-in's (`lib/local-session.ts`) — are rows in the same table and
    // slide by the same rule once they exist.
    ...(isDemoMode()
      ? { maxAge: DEMO_SESSION_MAX_AGE_SECONDS, updateAge: DEMO_SESSION_MAX_AGE_SECONDS }
      : {
          maxAge: 24 * 60 * 60, // Sign-in required after 24 hours of inactivity
          updateAge: 60 * 60, // At most one session-row write per user per hour
        }),
  },
  providers: [
    // Each provider is registered only when its credentials are all set (see
    // `lib/auth-providers.ts`), so production can run GitHub-only and enable
    // Google later purely through environment. The login page reads the same
    // helper, so buttons and providers never disagree.
    //
    // `allowDangerousEmailAccountLinking` links accounts that share an email
    // address across providers. That is only safe while **every** provider
    // it is set on verifies email ownership — GitHub and Google both do.
    // Adding a provider that does not (or that lets users self-assert an
    // address) turns this into an account-takeover path: anyone who can claim
    // a victim's address at the weak provider inherits their StackRadar
    // account. The generic OIDC provider below therefore does NOT set it: we
    // cannot know whether an arbitrary issuer verifies email, and an install
    // whose IdP does can still link by signing in once with each.
    ...(isProviderEnabled("github")
      ? [
          GitHub({
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    ...(isProviderEnabled("google")
      ? [
          Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    // Generic OpenID Connect — Keycloak, Authentik, Entra ID, Okta, Zitadel
    // (open-source plan step 04 §5). Discovery from `AUTH_OIDC_ISSUER`; the
    // button says `AUTH_OIDC_NAME`. Enterprise SSO (SAML, SCIM, enforced
    // SSO) is the cloud's and is not this.
    ...(isProviderEnabled("oidc")
      ? [
          {
            id: "oidc",
            name: oidcDisplayName(),
            type: "oidc",
            issuer: process.env.AUTH_OIDC_ISSUER,
            clientId: process.env.AUTH_OIDC_ID,
            clientSecret: process.env.AUTH_OIDC_SECRET,
            // `openid email profile` is what every issuer grants; a groups
            // claim often needs its own scope (Okta: `groups`), hence the override.
            authorization: { params: { scope: process.env.AUTH_OIDC_SCOPE?.trim() || "openid email profile" } },
            profile(profile) {
              const isAdmin = oidcAdminFromProfile(profile)
              return {
                id: profile.sub,
                name: profile.name ?? profile.preferred_username ?? profile.email ?? null,
                email: profile.email ?? null,
                image: profile.picture ?? null,
                // Only when the mapping is configured: an `undefined` here
                // leaves the column to its default on insert.
                ...(isAdmin === undefined ? {} : { isAdmin }),
              }
            },
          } satisfies OIDCConfig<OidcProfile>,
        ]
      : []),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id
        session.user.isAdmin = user.isAdmin ?? false
        session.user.mustChangePassword = user.mustChangePassword ?? false
      }
      return session
    },
  },
  events: {
    // The `profile` callback only runs on *creation*; an existing user's
    // admin flag follows their IdP group on every sign-in here, so the IdP
    // stays the source of truth once `AUTH_OIDC_ADMIN_GROUP` is set.
    async signIn({ user, account, profile }) {
      if (account?.provider !== "oidc" || !profile || !user.id) return
      const isAdmin = oidcAdminFromProfile(profile)
      if (isAdmin === undefined || isAdmin === user.isAdmin) return
      await db.update(users).set({ isAdmin, updatedAt: new Date() }).where(eq(users.id, user.id))
    },
  },
  logger: {
    // Keeps the default `[auth][error]` output — ops alerting greps for it —
    // while latching configuration-level failures so `/api/health/ready` can
    // take the pod out of rotation. See `lib/auth-health.ts` for why.
    error(error) {
      recordAuthError(error)
      const name = (error as { type?: string }).type ?? error.name
      console.error(`[auth][error] ${name}: ${error.message}`)
      if (error.stack) console.error(error.stack)
    },
  },
  // Organization setup is handled on first dashboard load via OrganizationProvider
  // This keeps auth lightweight and allows for better UX during setup
})

# Authorization matrix

Who may do what, on which edition. One row per decision the server makes,
with the file that makes it, so a reader can check the table against the
code rather than trust it. The client hides the controls these rows refuse
(`useRuntimeConfig().edition`, `isAdminOrOwner`, `demoMode`), but the row
is the rule; the UI is a courtesy.

Editions are `src/edition.ts`: **cloud** (app.stackradar.io, set
explicitly) and **community** (the default, a self-hosted install that is
the dashboard for the cluster it runs in). The multi-tenant model stays in
the community edition with exactly one organisation and one cluster in it,
so the two editions share one code path and one set of rules. The **Cloud**
and **Community** columns say what each edition answers; a surface that
exists only in the cloud is a 404 in the community edition, never a 403.

## Principals

| Principal | How it is proven | What it can reach |
|---|---|---|
| **Scanner (API key)** | `X-API-Key`, hashed and matched against an active `api_keys` row (`middleware/auth.ts` `validateApiKey`). Carries an org and, for every key minted today, a cluster. No user: `created_by` is audit metadata, never an identity. | The `/v1` ingest surface only (heartbeat, inventory, SBOM check/upload), each behind `requireScope("sbom:write")`. Every other route mounts `requireInternal` and answers 403 to a key. |
| **User (via the BFF)** | `X-Internal-Key` plus the identity headers the Next.js BFF sets from the Auth.js session; `requireOrg` re-verifies the `X-Org-Id` claim against `org_members` on every request. | Everything under `/api`, subject to the role rows below. |
| **Platform admin** | `X-Is-Admin: true`, set by the BFF from the client's `auth.users.is_admin` (`createApiHeaders` sets it only for admins, and the BFF's catch-all rejects `admin/*` for anyone else). **The server does not re-verify it**: `requireAdmin` reads the header-derived `req.auth.isAdmin`, so the claim rests on `INTERNAL_SERVICE_KEY` never leaving the BFF. | `/api/admin/*` (19 routes). |
| **Demo visitor** | `users.demo` / `organizations.demo`, set only by the seed script. | Reads only: every non-safe method is `403 read_only_demo` (`lib/demo.ts`, `middleware/auth.ts`). |

Org roles are `owner`, `admin`, `member` (`org_members.role`).
`requireAdminOrOwner` (`middleware/auth.ts`) admits the first two; the
owner-only checks are a local `requireOwner` helper in
`organization.controller.ts`.

## Organisations

| Action | Route | Cloud | Community | Where |
|---|---|---|---|---|
| First login | `POST /api/users/setup` | Creates "`<name>`'s Organization" on the free plan with the user as **owner**; records terms acceptance, sends the welcome email, stores sign-up attribution (`cloud/hooks.ts`). | Joins the one organisation, slug `default`, plan `community`, seeded at start-up. **First user to sign in is its owner; every later user is a member.** No terms, no email, no attribution. | `controllers/user.controller.ts` `setup`; `services/default-org.service.ts` |
| Create another organisation | `POST /api/users/organizations` | 201; `409 FREE_ORG_LIMIT` if the user is already in a free org. | **`403 single_organization`.** | `middleware/edition.ts` `requireMultiOrg` |
| Rename, colour, digest toggle, default findings view | `PATCH /api/organizations/:id` | admin/owner | admin/owner | `organization.routes.ts` |
| Delete the organisation | `DELETE /api/organizations/:id` | owner; the cloud cancels the Stripe subscription first and refuses if it cannot. | owner. (The seed recreates an empty `default` on the next start; nothing stops an owner from deleting their own install's data.) | `organization.controller.ts`, `cloud/hooks.ts` `beforeOrganizationDelete` |
| Join a system org | any member write | Never: `addOrgMember` throws. | Never. | `organization.repository.ts` |
| Join the demo org | any member write | Never, except the seed script. | n/a (no demo). | `organization.repository.ts` |

## Members and invites

| Action | Route | Cloud | Community | Where |
|---|---|---|---|---|
| List members | `GET /api/organizations/:id/members` | member | member | `organization.routes.ts` |
| Change a role, remove a member | `PATCH` / `DELETE …/members/:userId` | admin/owner; the owner's own row is untouchable and only the owner may promote to admin | same | `organization.controller.ts` |
| Create an invite | `POST /api/organizations/:id/invites` | admin/owner, under the plan's member limit; the invite is **emailed** (Resend) and the link returned. | admin/owner, no member limit; **link invite only** — the email status is `not_configured` and the admin copies the URL. | `invite.controller.ts`; `cloud/hooks.ts` `sendInviteEmail` |
| Accept an invite | `POST /api/invites/:token/accept` | any signed-in user; the cloud binds terms acceptance to the org. | any signed-in user, who thereby joins `default` with the invited role. | `invite.controller.ts` |
| Accept terms | `GET/POST /api/users/terms*` | required before the app renders. | **404**: the router is not mounted. | `cloud/index.ts`, `app.ts` |

## Clusters and scanner keys

| Action | Route | Cloud | Community | Where |
|---|---|---|---|---|
| List clusters, read one, coverage, findings | `GET /api/clusters*` | member | member | `cluster.routes.ts` |
| Create a cluster (mints its scanner key) | `POST /api/clusters` | admin/owner, under the plan's cluster limit (`PLAN_LIMIT_EXCEEDED`). | **`403 single_cluster`.** The one cluster, named `local`, is created at start-up from `BOOTSTRAP_CLUSTER_ID`; without that variable the install has no cluster and readiness warns. | `middleware/edition.ts` `requireMultiCluster`; `services/default-org.service.ts` |
| Rename a cluster | `PATCH /api/clusters/:id` | admin/owner | admin/owner | `cluster.routes.ts` |
| Delete a cluster | `DELETE /api/clusters/:id` | admin/owner; revokes its keys and deletes its images in the same transaction. | admin/owner. The seed recreates the bootstrap cluster (same id, name `local`) on the next start. | `cluster.repository.ts` `delete` |
| Read the scanner key (masked) | `GET /api/clusters/:id/api-key`, `GET /api/clusters/api-keys` | member | member — the bootstrap key shows with its prefix. | `cluster.controller.ts` |
| Reveal the scanner key | `POST /api/clusters/:id/api-key/reveal` | admin/owner, vault configured, audited; refused for the demo org. | admin/owner, same. The env-provided key is encrypted into the vault at start-up. | `cluster.controller.ts` `revealApiKey` |
| Rotate the scanner key | `POST /api/clusters/:id/api-key` | admin/owner | **`403 single_cluster`.** Rotation is changing `BOOTSTRAP_CLUSTER_API_KEY` and restarting: the old row is deactivated, the new one stored. | `middleware/edition.ts`; `default-org.service.ts` |
| Revoke the scanner key | `DELETE /api/clusters/:id/api-key` | admin/owner | **`403 single_cluster`.** | `middleware/edition.ts` |
| Mint a key for a system org or cluster | any key write | Never: `assertNotSystem` throws. | Never. | `cluster.repository.ts` |
| Upload into a cluster | `POST /v1/sboms/upload/cyclonedx`, `POST /v1/inventory` | the cluster's own key | the cluster's own key | `public.routes.ts` |

## Sign-in (the client, not Express)

Who may obtain a session at all. Decided in the Next.js client
(`client/src/auth.ts`, `client/src/lib/local-login.ts`, `client/src/proxy.ts`);
Express only ever sees the headers the BFF derives from a session. Every
method is decided by environment (`lib/auth-providers.ts`), so a deployment
adds or removes one by setting variables, not by changing code.

| Action | Route | Cloud | Community | Where |
|---|---|---|---|---|
| Sign in with GitHub / Google | `/api/auth/signin/github`, `…/google` | when `AUTH_GITHUB_*` / `AUTH_GOOGLE_*` are set | same | `lib/auth-providers.ts` |
| Sign in with a generic OIDC issuer | `/api/auth/signin/oidc` | when `AUTH_OIDC_ISSUER/ID/SECRET` are set (no email-linking: an unknown issuer may not verify email) | same; `AUTH_OIDC_ADMIN_GROUP` maps a group onto `users.isAdmin` at every sign-in | `auth.ts`, `lib/auth-providers.ts` `oidcAdminFromProfile` |
| Sign in with username and password | `POST /api/auth/local` | **404**: off unless `AUTH_LOCAL_ENABLED=true`. | **on by default** (`AUTH_LOCAL_ENABLED=false` turns it off). One `401` for unknown email, provider-only account, locked account and wrong password alike; 5 failures lock 15 min; 10 attempts/min per address. | `app/api/auth/local/route.ts` |
| Have a session with `must_change_password` | every route | n/a (no local accounts) | **only `/account/password`**, its route, sign-out and the probes; other pages redirect there, other API calls get `403 password_change_required`. | `proxy.ts` |
| Change own password | `POST /api/account/password` | 404 | the signed-in user, with the current password; revokes the account's other sessions | `app/api/account/password/route.ts` |
| Create a local account | `POST /api/admin/users` | 404 | **platform admin**; the account must change the password at first sign-in | `app/api/admin/users/route.ts` |
| Set or reset a local account's password | `PUT /api/admin/users/:id/password` | 404 | **platform admin**, local accounts only (never adds a password to a GitHub/Google/OIDC account); revokes the account's sessions | `app/api/admin/users/[id]/password/route.ts` |
| Reset from the shell | `pnpm admin:reset-password <email>` | whoever has shell + `DATABASE_URL` | same — the locked-out-admin path; `--create-local` is the one way to give a provider account a password | `client/scripts/admin-reset-password.mjs` |
| Bootstrap admin | server start | not created (local login off) | created once, when no account has a password: `AUTH_BOOTSTRAP_ADMIN_EMAIL` (default `admin@stackradar.local`), `isAdmin`, forced change; never modifies an existing user | `lib/bootstrap-admin.ts`, `instrumentation.ts` |
| Become the default org's owner | `POST /api/users/setup` | n/a | whoever signs in first — by any method above. | `controllers/user.controller.ts` |

## Cloud-only surfaces

Mounted by `cloud/index.ts` only when `edition.isCloud`; in the community
edition each is a **404**, not a 403 — the route does not exist there.

| Surface | Route(s) | Who |
|---|---|---|
| Billing (checkout, portal, slot counter) | `/api/billing/*`, `/v1/pricing` | owner for checkout/portal; `/v1/pricing` is public |
| Stripe and Resend webhooks | `/v1/webhooks/stripe`, `/v1/webhooks/resend` | signature-verified, no principal |
| Feedback inbox | `/api/feedback`, `/api/admin/feedback` | member to send; platform admin to read |
| Terms gate | `/api/users/terms*` | any signed-in user |
| Digest and alert unsubscribe | `/v1/digest/unsubscribe`, `/v1/alerts/unsubscribe` | signed token, no session |

## Live demo (cloud only)

The demo organisation and its visitor account are read-only everywhere:
`requireOrg` and `requireAuth` refuse every non-safe method with
`403 read_only_demo`, the client draws every org role as `member`
(`viewerRole`), and the demo org's scanner key keeps working so the picture
stays fresh. Nobody can be added to the demo org and the demo visitor cannot
be added anywhere; the demo rows exist only where the seed script
(`cloud/demo/demo-seed.service.ts`) created them.

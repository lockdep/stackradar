# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in the `client/` directory.

## What This App Is

Next.js 16 app that serves two roles:
1. **UI** — React frontend (App Router, single-page shell in `src/app/page.tsx`)
2. **BFF** — proxies authenticated requests from the browser to the Express backend

## BFF Route Pattern

The BFF is **one catch-all proxy**: `src/app/api/[...path]/route.ts`. It
checks the Auth.js session (401 `{ error }` without one), gates `admin/*`
paths on `session.user.isAdmin` (403 otherwise), then forwards the request
verbatim — method, path, query string, body, Content-Type — to the Express
backend at the same `/api/*` path, with the internal headers from
`createApiHeaders`. The Express response streams back untouched. BFF and
Express paths map 1:1 by construction; there is no rewrite table.

Only routes that genuinely cannot be a verbatim proxy exist as explicit
files (Next.js routes more-specific segments before the catch-all, so these
win structurally — that is also how auth and health are excluded from
proxying rather than by a denylist):

- `auth/[...nextauth]` — Auth.js handlers
- `health/live`, `health/ready` — probes; ready checks the client DB and
  Auth.js config, no Express involved
- `users/setup` — constructs its POST body from the session (the browser
  sends none); Express validates `{ userId, userName, userEmail }`
- `auth/local` — username/password sign-in; writes the Auth.js session row
  itself (see Authentication below). 404 unless local login is enabled.
- `account/password` — read/change the signed-in account's password; the
  hash lives in the client's `users` table and never reaches Express
- `admin/users`, `admin/users/[id]/password` — the admin Users tab: list
  accounts with how each signs in, create a local account, set or reset a
  local account's password. Same session + `isAdmin` gate as the catch-all;
  404 unless local login is enabled
- `admin/chart-index` — its upstream is not Express: it relays the charts
  site's key-gated `GET /internal/status` (`CHARTS_STATUS_URL` +
  `CHARTS_STATUS_KEY`) for the admin dashboard's Chart Index tab, behind
  the same session + `isAdmin` gate the catch-all applies to `admin/*`

Key utilities from `src/lib/api-utils.ts`:
- `getExpressUrl()` — reads `EXPRESS_API_URL` env var
- `createApiHeaders(session, request?)` — async; builds the internal headers
  (`X-Internal-Key`, `X-User-Id`, …) and resolves the active org. The org
  comes from the `sr_org_id` cookie on the incoming `NextRequest` (validated
  against the user's actual memberships) or the user's first org as a
  fallback. Always pass `request` so the active-org switcher works.
- `handleApiError(error, reqId?)` — returns a 500 JSON response
- `getRequestId(request?)` — propagates or generates `x-request-id`

Server routes that are gated by `requireOrg` (anything under `/api/containers`,
`/api/namespaces`, `/api/images`, `/api/releases`, `/api/clusters`,
`/api/billing`, `/api/sboms`) will respond with
`403 Organization setup required` if `X-Org-Id` is missing — that's why
`createApiHeaders` does the resolution itself and you should always `await`
it. See `server/docs/db-audit/P0-correctness.md` § P0-1 for context.

## Authentication

Auth.js v5 (`src/auth.ts`) with GitHub and Google OAuth, generic OIDC
(`AUTH_OIDC_ISSUER/ID/SECRET`, optional `AUTH_OIDC_NAME`, `AUTH_OIDC_SCOPE`,
`AUTH_OIDC_ADMIN_GROUP` + `AUTH_OIDC_GROUPS_CLAIM` to map a group onto
`users.isAdmin` at every sign-in), and **local username/password**
(`src/lib/local-login.ts`; on by default in the community edition, off in the
cloud, `AUTH_LOCAL_ENABLED` overrides). Database sessions (not
JWT), so sessions are revocable server-side, with a **24-hour idle window** —
`maxAge` slides, so active users are never interrupted and abandoned sessions
die within a day. The `auth()` helper is used in BFF routes and server
components to get the current session. `src/proxy.ts` is the
route gate (Next 16 renamed `middleware.ts` → `proxy.ts`); it redirects
unauthenticated requests to `/login` for everything outside its `publicRoutes`
list.

> [!IMPORTANT]
> **Always gate on `session?.user`, never on the bare `session` object.**
> `GHSA-8fpg-xm3f-6cx3` (critical) was an Auth.js bug where a *configuration*
> error made `auth()` return a truthy error object, so `if (session)` checks
> failed **open** — every anonymous visitor was treated as signed in. The
> version pinned here fixes it, but the guard style is what makes the
> codebase resilient to the class of bug. Every BFF route and `proxy.ts`
> follow this rule.

`src/lib/auth-health.ts` is the defence-in-depth half of that: it validates the
Auth.js environment and latches configuration-level Auth.js errors, and
`/api/health/ready` returns 503 when either is broken — a pod that cannot
authenticate anyone leaves the Service instead of serving a broken sign-in.
**A deployed environment must set `AUTH_TRUST_HOST=true` (or `AUTH_URL`)** or
readiness will fail; we self-host behind an ingress, so Auth.js cannot infer
its own origin.

**Live demo** (`docs/live-demo/` step 02): with `DEMO_MODE=true` — set only
on the demo Deployment, same image — `src/app/demo/enter/route.ts` writes a
two-hour non-sliding `sessions` row for the `users.demo` account and sets the
Auth.js cookie itself; `proxy.ts` sends `/login` there. `useRuntimeConfig().demoMode`
is how components leave out controls the server refuses (`viewerRole` in
`src/lib/demo.ts` reports every org role as `member` for that purpose), and
`AppShell` adds the banner and the `read_only_demo` toast. Unset, none of it
is reachable — that is the property to keep.

**Local sign-in** (open-source plan step 04): `POST /api/auth/local` verifies
an argon2id hash (`src/lib/password.ts`, `@node-rs/argon2`) and then mints the
session exactly as the demo's door does — `src/lib/local-session.ts` writes
the `sessions` row and sets the Auth.js cookie; both callers share it, so the
session model is unchanged. Every refusal is one `401`, one body and one
argon2 verification (`verifyAgainstNothing` for the paths with no hash);
five failures lock the account 15 minutes; ten attempts a minute per address
in-process (a multi-replica client needs the limit at the ingress).
`users.must_change_password` is enforced by `proxy.ts`: the session can reach
`/account/password` (+ its route, sign-out, probes) and nothing else, pages
redirect, API calls get `403 password_change_required`. `src/instrumentation.ts`
seeds the bootstrap admin (`AUTH_BOOTSTRAP_ADMIN_EMAIL`/`_PASSWORD`, default
`admin@stackradar.local` / `admin`, forced change) on start when no account
has a password yet, retrying while Postgres comes up; it never touches an
existing user. `pnpm admin:reset-password <email>` (`scripts/`, plain Node,
copied into the image) is the locked-out path. Readiness refuses a deployment
with zero sign-in *methods*, local counting as one.

`next-auth` is pinned to an exact beta version (no `^`) on purpose — v5 betas
do not honour semver, so the range must never float. Check
`https://github.com/advisories?query=next-auth` before bumping.

The `INTERNAL_SERVICE_KEY` env var is the shared secret sent to Express as `X-Internal-Key`. It must match the server's value.

## UI Structure

`src/app/page.tsx` is the shell — it renders a sidebar and conditionally mounts views based on navigation state. Views live in `src/views/`:

| View | Purpose |
|------|---------|
| `ClustersView.tsx` | Cluster list |
| `ContainerDetailView.tsx` | One running container, with its image's SBOM, components and vulnerabilities |
| `ReleaseDetailView.tsx` | A Helm release: its containers, its distinct images, its aggregate findings |
| `OrganizationSettingsView.tsx` | Team management, billing |
| `ProfileView.tsx` | User profile |
| `ContainersView.tsx` | `/containers` — every running container in the org, flat, worst first; cluster and namespace filters in the URL |
| `ImagesView.tsx` | `/images` — every running image in the org, one row per image (per cluster), worst first; reads `GET /api/images` and reuses the containers list's URL hook, coverage strip and scan dot |

The containers list (`/clusters/[id]/containers`) always groups by **namespace**.
The unit throughout is a `workload_containers` row: findings hang off the
*image* it references, so a workload with two containers on two images has two
answers to "what is wrong with it" and this shape gives both. See
[ADR 0004](../docs/adr/0004-image-as-the-unit-of-identity.md).

The org-wide `/containers` page is the same list without the fold: one flat
table with Cluster and Namespace columns, sorted by Radar Score. The cluster
tab and the org page **share** `ContainerRow`, `ContainersFilterBar`, the
caption, the coverage strip and `useContainersView` from
`src/components/containers/`, and must keep doing so — where one needs to
differ, add a prop, never a copy. Both read the unpaginated
`GET /api/containers` and narrow it in the browser; see
`docs/containers-page-plan-2026-09-13.md`.

Reusable UI components are in `src/components/ui/`. The active organization is tracked via `OrganizationProvider` (`src/components/providers/OrganizationProvider.tsx`).

**Colour**: every colour is decided in `src/app/theme.css` (GitHub Primer palette, semantic tokens like `bg-surface`, `text-ink-muted`, `bg-danger-subtle`). Never write a raw palette class — see the `ui-theming` skill.

The raw palette (LAYER 1 of `theme.css`) is **generated** from the
`@primer/primitives` devDependency, not hand-written. Use `pnpm tokens:find <term>`
to look a Primer token up, `pnpm tokens:check` to verify (run it before committing
`theme.css`) and `pnpm tokens:sync` to pull upstream values in. Divergences from
Primer are pinned with a reason in `scripts/primer-token-map.mjs`.

## Adding a New BFF Route

Usually: **don't**. Add the route on the Express side and call it from the
browser at the same path — the catch-all proxies `/api/{path}` to Express
`/api/{path}` automatically, auth and org context included.

Create an explicit `src/app/api/{resource}/route.ts` only when the route
cannot be a verbatim proxy (body construction, response reshaping,
multipart handling, no Express upstream). It then takes precedence over the
catch-all for its path.

## Database (Auth Tables Only)

The client has its own Drizzle schema for Auth.js tables (`src/db/schema/`). This is separate from the server DB. Author migration files with `pnpm db:generate`. Besides Auth.js's columns, `users` carries `is_admin`, `demo` and the local-login quartet `password_hash` / `must_change_password` / `failed_logins` / `locked_until` (migration 0004).

> [!IMPORTANT]
> Do **not** run `pnpm db:migrate` or `pnpm db:reset`. Migrations are applied **only** by ArgoCD as a pre-sync job during deployment — applying them is owned by the deploy pipeline, not local work.

## Environment Variables

See `.env.example` for the full list with comments. In short:

```
DATABASE_URL=postgresql://...         # 'client' database (Auth.js tables)
EXPRESS_API_URL=http://localhost:8080
INTERNAL_SERVICE_KEY=<shared with server>
AUTH_SECRET=<random string>
AUTH_TRUST_HOST=true                  # deployed envs only; readiness fails without it
AUTH_GITHUB_ID=<oauth app id>
AUTH_GITHUB_SECRET=<oauth app secret>
AUTH_GOOGLE_ID=<oauth client id>
AUTH_GOOGLE_SECRET=<oauth client secret>
AUTH_OIDC_ISSUER=<https://idp/...>    # + AUTH_OIDC_ID, AUTH_OIDC_SECRET: generic OIDC
AUTH_LOCAL_ENABLED=true               # default in community; false in cloud
AUTH_BOOTSTRAP_ADMIN_PASSWORD=<...>   # first-start admin; default `admin`, forced change
```

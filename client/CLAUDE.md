# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in the `client/` directory.

## What This App Is

Next.js 16 app that serves two roles:

1. **UI** — the React frontend (App Router; routes under `src/app/(app)/` share one shell layout and render views from `src/views/`)
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
- `admin/chart-index` — its upstream is not Express: it relays the public
  chart index's key-gated `GET /internal/status` (`CHARTS_STATUS_URL` +
  `CHARTS_STATUS_KEY`) for the admin dashboard's Chart Index tab
  (`src/cloud/admin/ChartIndexTab.tsx`), behind the same session + `isAdmin`
  gate the catch-all applies to `admin/*`. Cloud only: 404 in the community
  edition, where the tab is not drawn either

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
it.

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
> `GHSA-8fpg-xm3f-6cx3` (critical) was an Auth.js bug where a _configuration_
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

**Live demo**: with `DEMO_MODE=true` — set only
on the demo Deployment, same image — `src/app/demo/enter/route.ts` writes a
two-hour non-sliding `sessions` row for the `users.demo` account and sets the
Auth.js cookie itself; `proxy.ts` sends `/login` there. `useRuntimeConfig().demoMode`
is how components leave out controls the server refuses (`viewerRole` in
`src/lib/demo.ts` reports every org role as `member` for that purpose), and
`AppShell` adds the banner and the `read_only_demo` toast. Unset, none of it
is reachable — that is the property to keep.

**Local sign-in**: `POST /api/auth/local` verifies
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
with zero sign-in _methods_, local counting as one.

`next-auth` is pinned to an exact beta version (no `^`) on purpose — v5 betas
do not honour semver, so the range must never float. Check
`https://github.com/advisories?query=next-auth` before bumping.

The `INTERNAL_SERVICE_KEY` env var is the shared secret sent to Express as `X-Internal-Key`. It must match the server's value.

## UI Structure

Real Next.js routes under `src/app/(app)/` share one shell layout
(`src/app/(app)/AppShell.tsx`: sidebar, organization context, the demo and
mirror banners). Route files are thin: each reads its params or search
params and renders a view from `src/views/`; a route file never carries
state of its own.

| Route                                                         | Renders                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                           | `DashboardView`                                                                                                                                                                                                   |
| `/vulnerabilities`, `/packages`, `/containers`, `/images`     | `VulnerabilitiesView`, `PackagesView`, `ContainersView`, `ImagesView` — every cluster's tab folded into one org-wide list, filters in the URL                                                                     |
| `/clusters`, `/clusters/[id]/(tabs)/*`                        | the cluster list, and one cluster's Overview, Containers (`ClusterContainersView`), Vulnerabilities, Packages, Charts (`ClusterChartsView`), Radar Score and Settings tabs, built from `src/components/clusters/` |
| `/clusters/[id]/containers/[containerId]`                     | `ContainerDetailView` — one running container, with its image's SBOM, components and vulnerabilities                                                                                                              |
| `/images/[id]`, `/releases/[id]`, `/vulnerabilities/[vulnId]` | `ImageDetailView`, `ReleaseDetailView`, one advisory                                                                                                                                                              |
| `/feed`, `/radar-score`                                       | `FeedView`, the org-wide Radar Score page                                                                                                                                                                         |
| `/admin`, `/org-settings`, `/profile`                         | the platform admin tabs (`src/views/admin/`, with the cloud-only tabs from `src/cloud/admin/`), `OrganizationSettingsView`, the profile page                                                                      |

`/login`, `/invite/[token]`, `/account/password` and `/demo/enter` live
outside the shell.

The containers list (`/clusters/[id]/containers`) always groups by **namespace**.
The unit throughout is a `workload_containers` row: findings hang off the
_image_ it references, so a workload with two containers on two images has two
answers to "what is wrong with it" and this shape gives both. See
[ADR 0004](../docs/adr/0004-image-as-the-unit-of-identity.md).

The org-wide `/containers` page is the same list without the fold: one flat
table with Cluster and Namespace columns, sorted by Radar Score. The cluster
tab and the org page **share** `ContainerRow`, `ContainersFilterBar`, the
caption, the coverage strip and `useContainersView` from
`src/components/containers/`, and must keep doing so — where one needs to
differ, add a prop, never a copy. Both read the unpaginated
`GET /api/containers` and narrow it in the browser.

Reusable UI components are in `src/components/ui/`. The active organization is tracked via `OrganizationProvider` (`src/components/providers/OrganizationProvider.tsx`).

The big list surfaces are split along one seam each: a stateless toolbar
(heading, caption, filter bar) and the rows. `src/components/clusters/VulnerabilityList.tsx`
holds the hooks and composes `VulnerabilityListToolbar.tsx` and
`VulnerabilityRows.tsx`; the expanded row is `VulnerabilityExpandedPanel.tsx`
over `VulnerabilityAffected.tsx`, `VulnerabilityImageDetail.tsx`,
`VulnerabilityContainersTable.tsx` and `VulnerabilityAdvisory.tsx`, with the
pure helpers in `vulnerability-affected.ts`. `src/views/ImagesView.tsx`
composes `src/components/images/` the same way, and the dashboard's
`src/components/dashboard/RecentMovement.tsx` composes `MovementRow.tsx` and
`MovementFindings.tsx` over `movement-query.ts`.

**Fetching.** Two ways, and only two. A GET that drives a view goes through
`useResource` / `usePagedResource` (`src/hooks/`). Everything else — every
mutation, a one-shot read inside a handler — goes through `apiFetch` in
`src/lib/api-client.ts`, which checks `res.ok`, reads the `{ error }`
envelope, runs the session-lost reload on 401 and throws a typed `ApiError`.
A raw `fetch()` in browser code is a bug unless the site says why (the SBOM
document download is the one case). Sign-in passes `on401: 'throw'`, because
there a 401 is the answer, not a lost session.

**Analytics.** `src/lib/analytics.ts` is the only thing a component calls
(`capture(event, props)`); it is a no-op until `PostHogProvider` has a key
and has `import()`ed `posthog-js`. A build without `POSTHOG_KEY` does not
carry the SDK; never import `posthog-js` outside the provider.

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

One PostgreSQL database, shared with the server. This app's Drizzle project
(`src/db/schema/`, `pgSchema("auth")`) owns only the Auth.js tables —
`users`, `accounts`, `sessions`, `verification_tokens` — in the **`auth`**
schema of that database; the server's application data is in `public`, and
nothing in either Drizzle project references the other's schema. Both apps
read the same `DATABASE_URL`. This app's journal is
`auth.__drizzle_migrations` (`drizzle.config.ts`), so the two migration
chains never collide. Besides Auth.js's columns, `users` carries `is_admin`,
`demo` and the local-login quartet `password_hash` / `must_change_password` /
`failed_logins` / `locked_until`.

Author migration files with `pnpm db:generate`. Applying them is the
deployment's job: a self-hosted install sets `MIGRATE_ON_START=true`, and
`scripts/migrate.mjs` runs before `next start` (`docker-entrypoint.sh`) under
the same advisory lock the server migrates under, so replicas of either app
serialise; `MIGRATE_EXIT_AFTER=true` migrates and exits 0 instead. Against
your own local Compose database, `pnpm db:migrate:boot` runs the same script.

> [!IMPORTANT]
> Never run `pnpm db:migrate`, `drizzle-kit push` or `pnpm db:reset` against a shared (dev/prod) database: there, migrations are applied only by the deploy. Your local database is yours.

## Environment Variables

See `.env.example` for the full list with comments. In short:

```
DATABASE_URL=postgresql://...         # the server's database; this app uses its `auth` schema
STACKRADAR_EDITION=community          # or `cloud`; unset means community
MIGRATE_ON_START=true                 # self-hosted: apply this app's migrations before `next start`
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
SCANNER_CHART_VERSION=<x.y.z>         # chart version in the install command; unset shows a <version> placeholder
PUBLIC_API_URL=https://api.example.com # the API origin a cluster can reach (same name as the server's); the install
                                      # command points the scanner at it. Community: unset shows a <PUBLIC_API_URL>
                                      # placeholder and a sentence, never the hosted URL. Cloud: unset = hosted
POSTHOG_KEY=phc_...                   # cloud analytics; unset = no analytics and no posthog-js in the bundle
```

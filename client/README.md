# StackRadar client

The Next.js 16 app behind the StackRadar dashboard: the React UI (App Router,
thin routes under `src/app/(app)/`, the pages themselves in `src/views/`,
shared pieces in `src/components/`) and the BFF that fronts the Express
server in `../server/`. Start with [`../DEVELOPING.md`](../DEVELOPING.md)
for prerequisites and how the two apps run together; copy `.env.example` to
`.env.local` for the variables this app reads.

Commands (run inside `client/`):

- `pnpm dev` — the app on http://localhost:3000, against the server on 8080
- `pnpm test` — Vitest (unit and route-handler tests; no database needed)
- `pnpm lint`, `pnpm knip` — ESLint, and the unused-export check CI runs
- `pnpm db:migrate:boot` — apply this app's Auth.js migrations to your local database

**BFF and auth.** Authentication happens here, not in Express: Auth.js v5 with
database sessions (GitHub, Google, generic OIDC, or local username/password).
The BFF is one catch-all route, `src/app/api/[...path]/route.ts`, that checks
the session, resolves the active organization, and forwards the request
verbatim to Express with the shared `INTERNAL_SERVICE_KEY`; only routes that
cannot be a verbatim proxy have files of their own. Browser code reaches it
two ways: `useResource` / `usePagedResource` (`src/hooks/`) for the reads
that drive a view, `apiFetch` (`src/lib/api-client.ts`) for everything else.
`CLAUDE.md` in this directory has the details.

**Self-hosting.** Set `PUBLIC_API_URL` to the API origin your clusters can
reach; the "Connect cluster" install command is rendered from it and shows a
placeholder until it is set. Product analytics (`src/lib/analytics.ts`) load
`posthog-js` only when `POSTHOG_KEY` is set, so a community build carries
neither the SDK nor any call home. Everything under `src/cloud/` is the hosted
edition's and is source-available under its own licence; the rest is AGPL.

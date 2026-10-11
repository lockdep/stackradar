# Client

The Next.js frontend and its Backend-for-Frontend (BFF). Owns authentication and the active-organization context, and proxies application requests to the server.

## Language

**BFF**:
The Next.js API layer (`/client/src/app/api/`) that sits between the browser and the Express server: one catch-all route (`[...path]/route.ts`) that authenticates the user, then proxies to Express with an internal service key, plus a handful of explicit routes that can't be a verbatim proxy (Auth.js handlers, health probes, `users/setup`).
_Avoid_: gateway, middleware, backend (the BFF is a distinct layer; "backend" means the Express **Server**)

**Proxy**:
The act of the BFF forwarding a request to the Express **Server**, attaching the `INTERNAL_SERVICE_KEY` header. Note: `src/proxy.ts` is _not_ this — it is the Auth.js route gate (Next 16 renamed `middleware.ts` → `proxy.ts`) that redirects unauthenticated page requests to `/login`.
_Avoid_: forward, passthrough

**Session**:
A database-backed Auth.js v5 session identifying the signed-in **User**. Lives in the client database, not a JWT.
_Avoid_: token, cookie, JWT (the session is server-side; the cookie only references it)

**Active Organization**:
The **Organization** currently in scope for the UI, tracked by `OrganizationProvider`. All org-scoped requests carry it.
_Avoid_: current team, selected org, tenant

**View**:
A top-level screen component under `/client/src/views/`, kept as a separate file only when its `page.tsx` adds something around it — route params (`ContainerDetailView`, `ReleaseDetailView`), or a search-param prop (`OrganizationSettingsView`) — plus the admin tab screens under `views/admin/`. Screens whose page was a pure passthrough (dashboard, clusters list, admin shell, profile) live directly in their `page.tsx` under `app/(app)/` — the dashboard at `/`, plus `/clusters` (and `/clusters/[id]` with its tab sub-routes), `/images/[id]`, `/releases/[id]`, `/admin`, `/org-settings` and `/profile`; `/login` and `/invite/[token]` sit outside the shell.
_Avoid_: tab (Views are routed pages sharing the `(app)` shell layout)

**Internal Service Key**:
The shared secret (`INTERNAL_SERVICE_KEY`) the BFF adds when proxying, proving the request came from the trusted BFF and not the public internet.
_Avoid_: api key (an **API Key** is the customer/CI credential on the server side — different concept)

## Relationships

- A **User** authenticates at the **BFF**, which creates a **Session**
- The **BFF** proxies authenticated requests to the Express **Server** using the **Internal Service Key**
- `OrganizationProvider` sets the **Active Organization** for all org-scoped **Views**
- A **View** is rendered by its route inside the shared `(app)` shell layout

## Example dialogue

> **Dev:** "Does the browser call Express directly?"
> **Domain expert:** "No — for authenticated traffic the browser hits the **BFF**, which checks the **Session** and **Proxies** to the **Server** with the **Internal Service Key**. The only direct-to-Express path is public SBOM uploads using an **API Key**."

## Flagged ambiguities

- "key" was overloaded — resolved: **Internal Service Key** (BFF→Server trust, this context) vs **API Key** (the scanner agent's cluster-scoped upload credential, server context). Never use "key" unqualified.
- "page" vs "View" — resolved: routes are real Next.js pages under `app/(app)/`; a **View** is the screen component (`src/views/`) a route renders. Use "View" for the component, the route path for navigation.

## Glossary — one user-facing word per concept (2026-09-12)

Decided in `docs/dashboard-reflow-plan-2026-09-12.md` item 9. UI copy and the
landing page use these words; nothing else for the same thing.

| Concept                                                          | Word                                                       | Not                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| The thing you count: one advisory on one package in one image    | **finding**                                                | vulnerability, CVE, issue                                                                                             |
| The row unit of the Vulnerabilities lists: the advisory identity | **vulnerability**                                          | advisory, CVE (use "CVE"/"GHSA" only when quoting an identifier; "advisory" only for the published OSV record itself) |
| A finding's 0–100 score                                          | **Risk** as a column header, **contribution** in prose     | Radar Score, risk score                                                                                               |
| The unbounded per-image/container/release/cluster/org sum        | **Radar Score**                                            | risk score, total risk                                                                                                |
| A third-party library in an SBOM                                 | **package**                                                | component (`components` stays in API paths and DB tables)                                                             |
| A Helm chart deployment                                          | **Charts** as the tab, "Release: <name>" as a detail title | —                                                                                                                     |
| When the SBOM was generated                                      | **Scanned** (tooltip: "SBOM generated <date>")             | SBOM generated, inventoried                                                                                           |
| When packages were last matched against advisories               | **Checked** (tooltip: "Advisories checked …")              | Advisories checked, matched, synced                                                                                   |
| The action of adding a cluster                                   | **Connect a cluster**                                      | Add cluster, New cluster, Add Kubernetes cluster                                                                      |
| The top plan tier                                                | **Business** (plan key stays `team`)                       | Team                                                                                                                  |

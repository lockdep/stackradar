# Plan: one admin view that is right in both editions

Status: implemented 2026-10-18, one commit per phase on five stacked
branches (`fix/admin-community-tenant-surface` → `feat/admin-system-tab` →
`feat/admin-overview-pipeline` → `feat/admin-actions` →
`feat/admin-people-and-groups`), each to be its own pull request in that
order. Decisions taken where the plan left them open: the client's
version reaches the System tab through its explicit BFF route (which also
adds the sign-in methods and the auth chain's verdict), not
`RuntimeConfig`; the split topology refuses a feed trigger with the
CronJob's name rather than enqueueing a job; the cloud Overview keeps the
pipeline at the top and the tenant cards below it. Written 2026-10-18
from a read of `client/src/app/(app)/admin/page.tsx`,
`client/src/views/admin/`, `server/src/routes/admin.routes.ts` and the
repositories behind them.

## Why

The admin page (`/admin`) was written for the cloud operator: tenants,
plans, cross-tenant reuse. The community edition reuses it with three tabs
filtered out (Feedback, Chart Index, and Users unless local login is on),
and everything else still speaks to a multi-tenant audience. A
self-hosting admin has one question, "is my install working", and the page
answers it in pieces across four tabs while showing them organizations,
plans and tenant copy that mean nothing in their install.

Two of the leaks are wrong today, not just off-key:

- The Organizations tab renders usage against `getAdminPlanLimits(plan)`
  (`client/src/views/admin/utils.ts`), whose map knows `free`, `pro` and
  `team`. The community org's plan is `community`
  (`services/default-org.service.ts`), so it falls back to the free limits
  and a three-member install reads "3 / 1 members".
- The Overview's "Organizations by Plan" panel iterates `['free', 'pro']`
  and draws two empty bars in community.

A third is stale in both editions: the Images tab's usage cell and the
Overview's inventory panel still say `images` has no org column and that
one SBOM serves several tenants. [ADR 0006](../adr/0006-images-are-cluster-scoped.md)
reversed that; `images.org_id` exists and `orgCount` cannot exceed 1.

## Principles

1. **One page, one component tree, gated by capabilities.** No fork into
   `views/admin-community/`. Every edition difference reads
   `useRuntimeConfig().edition` (client) or `edition` from `src/edition.ts`
   (server), exactly as the org switcher and the Billing tab do today. The
   flag that hides the tenant surface is `multiOrg`, which already exists
   and already means "more than one organisation per install".
2. **Tabs declare what they need; the page does not know.** Replace the three
   ad hoc conditions in `page.tsx` with a `requires` field on each tab entry
   (`'multiOrg' | 'support' | 'isCloud' | 'localLogin'`) and one filter.
3. **The community admin page answers "is it working" first.** Its Overview is
   the pipeline, scanner to mirror. The cloud Overview is the same pipeline
   plus the tenant figures, so nothing is lost there.
4. **Readings come with actions.** Where a tile says a person has to act,
   the action is a button on the tile. Every action is an admin-only POST,
   idempotent, refusing while a run is already in progress, and it
   enqueues or triggers the existing code path rather than a second one.
5. **Copy is edition-neutral or edition-aware, never cloud-by-default.**
   "Platform", "tenant", "the owning org's plan" read as the cloud. In
   community the page is the one install's administration page.

## Tab inventory after the change

| Tab | Community | Cloud | Change |
|---|---|---|---|
| Overview | yes | yes | Reshaped around the pipeline; tenant cards cloud-only |
| System | yes | yes | New: versions, edition, topology, config, migrations |
| Organizations | no | yes | `requires: 'multiOrg'`; fix plan limits; hide system org |
| Users | if local login | if local login | Add admin grant/revoke for existing accounts |
| Feedback | no | yes | unchanged |
| Images | yes | yes | Drop org count; fix ADR 0006 copy; edition-aware retention text |
| Vulnerabilities | yes | yes | unchanged content; folded under one strip (phase 4) |
| Matcher | yes | yes | same |
| Explorer | yes | yes | Skip the org picker when `!multiOrg` |
| OSV Sync | yes | yes | Add "run incremental now" and "bootstrap if needed" |
| Feeds | yes | yes | Add "run now" per feed |
| Jobs | yes | yes | Org column cloud-only; add retry on out-of-retries jobs |
| Chart Index | no | yes | unchanged |

The page title and subtitle become edition-aware: cloud keeps "Admin
Dashboard · Platform-wide health and statistics"; community reads
"Administration · This install's health, data and accounts". The sidebar
label follows.

## Phases

Each phase is one pull request, in order. Phases 1 and 2 are the fix; 3 to
5 are the improvements and can be reordered.

### Phase 1: remove the tenant surface from community, fix what is wrong

Smallest change that makes the community page correct. Label `defect`.

Client:

- `page.tsx`: tab entries carry `requires`; `tabs = TABS.filter(t => !t.requires || caps[t.requires])` where `caps` is `{ ...edition, localLogin }`. Organizations gets `requires: 'multiOrg'`. The `selectedOrg` drill-down (`AdminOrgDetail`) is only reachable from that tab, so it disappears with it.
- `OverviewTab.tsx`: wrap the Organizations stat card and the "Organizations by Plan" panel in `edition.multiOrg`. Make the plan panel iterate `Object.keys(stats.organizations.byPlan)` sorted, not a literal list, so a `team` or future plan shows and an empty plan does not.
- `OrganizationsTab.tsx` / `utils.ts`: add `community` to `ADMIN_PLAN_LIMITS` mirrored from `server/src/config/plans.ts` (or better: have `/api/admin/organizations` return each org's effective limits from `getPlanLimits`, which already applies the community rule, and delete the client mirror). Prefer the second; it removes a drift surface the `cross-app-drift` gate does not cover.
- `JobsTab.tsx`: Org column and the Organization field in the detail `multiOrg`-only.
- `ImagesTab.tsx`: drop the org-count half of `UsageCell` (ADR 0006 makes it constant 1); keep the container count. Rewrite the orphaned hint and the footer: "collected once unreferenced for N days" with N from `retentionDays`, no mention of plans in community. The "cross-tenant reuse" comment block goes.
- `OverviewTab.tsx` inventory panel subtitle: replace the "no org column" sentence with one that is true after ADR 0006 (cluster-scoped images, counted once per cluster).
- `ExplorerTab.tsx`: when `!multiOrg`, select the single org from the organizations response automatically and start on the image list; the breadcrumb starts at "Images". Keep the picker on the cloud.
- `Sidebar.tsx` and the page header: edition-aware label and subtitle.

Server:

- `adminRepository.getRecentOrganizations`: exclude `system = true` (the platform org from `platform.service.ts`), and exclude it from `getSystemStats().organizations` too. Verify with a test that a system org is not counted.
- `/api/admin/organizations`: return `limits: { members, clusters, sboms }` per row from `getPlanLimits(plan)`.

Tests:

- Client: a page-level test (pattern: `client/src/cloud/admin/ChartIndexTab.test.tsx`) rendering the tab strip under each edition and asserting the tab set from the table above.
- Server: `admin-status.repository` and `admin.repository` tests for the system-org exclusion and the limits field.

Acceptance: a community install shows no word "organization" or "plan" on `/admin`; the cloud page is unchanged except for the plan-panel fix and the ADR 0006 copy.

### Phase 2: System tab

New tab, both editions, read-only. Label `enhancement`.

Server, `GET /api/admin/system`:

- `versions`: server `package.json` version and `GIT_SHA` (the Dockerfile already sets `ENV GIT_SHA`); the client adds its own two when rendering (the BFF knows them from its own `package.json` and env, so the route file reshapes, which is the one justification for an explicit BFF route; alternatively the client reads them from `RuntimeConfig`).
- `edition`, `topology` (`src/topology.ts`), `node` version, `uptimeSeconds`.
- `config`: the operator-visible knobs with their effective values, never secrets: `OSV_ECOSYSTEMS` as configured and as the live generation carries (both already in `getOsvStatus`), `IMAGE_GC_RETENTION_DAYS`, `SCANNER_MIN_VERSION`, `ARTIFACT_HUB_SYNC_ENABLED`, `APP_URL`, `PUBLIC_API_URL`, `LOG_LEVEL`, `MIGRATE_ON_START`. Mark each as `set` or `default`.
- `migrations`: last applied row of `drizzle.__drizzle_migrations` and of `auth.__drizzle_migrations` (tag and created_at). The server can read both tables with one query each; it does not import the client's schema.
- `signIn`: which methods are on. The client knows this (`lib/auth-providers.ts`, `lib/local-login.ts`); the BFF route merges it in, or the tab fetches it from a client-side endpoint. Pick whichever keeps `INTERNAL_SERVICE_KEY` and OAuth secrets out of the response; only names and booleans travel.

Client: `views/admin/SystemTab.tsx`, a definition list in three cards (Build, Configuration, Database). No numbers in prose; values in a table.

Acceptance: an operator can answer "what version, what edition, which ecosystems, which login methods, is the schema current" from one screen.

### Phase 3: Overview as the pipeline

Reshape `OverviewTab` so the top of the page is one row per stage, left to right, each a `HealthTile` with a tone and a sentence. Label `enhancement`.

Stages and sources:

1. **Scanner**: per cluster, `scannerLastSeenAt` through `getScannerHealth` (`components/clusters/ScannerDot.tsx`, reuse), `scannerVersion` against `SCANNER_MIN_VERSION` and `SCANNER_CHART_VERSION` (`isScannerOutdated` from `scannerInstall.ts`), `kubernetesVersion`, and `ownerMetadataCollected === false` surfaced as a warning ("the agent could not read controllers", the null-is-not-false rule). Community shows the one cluster inline; cloud shows counts by health with a link to `/clusters`. Needs a small addition to `getSystemStats` (or a new `getScannerHealth` in `admin-status.repository.ts`) returning per-cluster rows in community and histogram in cloud.
2. **Inventory**: newest `workload_containers.last_seen_at` across the install; stale past the scanner's report interval is a warning.
3. **SBOMs**: `images.awaitingSbom` (exists) and newest `sboms.created_at`.
4. **Queue**: `QueueHealthTiles` as today.
5. **Mirror**: OSV lag as today; EPSS and KEV age and staleness from `getFeedsStatus` (the Feeds tab already computes `stale`), one tile each. The fresh-install bootstrap state (`/api/vulnerabilities/mirror`, `lib/mirror-status.ts`) is reused for the "still building" case rather than reimplemented.

Below the pipeline: the inventory figures panel as today, then (cloud only) the tenant cards and the plan panel from phase 1.

Acceptance: each stage has a tone; a stopped scanner, a stuck queue and a stale feed are each visible on the Overview without opening another tab.

### Phase 4: actions

Add the triggers the readings imply. Each is `POST /api/admin/...`, `requireAdmin`, returns `202` with the job id or `409` with the in-progress run when one is already running. Label `enhancement`.

- **Retry a job**: `POST /api/admin/jobs/:id/retry` on a `failed` job: reset to `pending`, `retry_count = 0`, clear the error. The "Out of retries" tile links to the Jobs tab filtered to those jobs, and each row gets Retry. Also "Retry all out-of-retries" on the tile, bounded to the current count.
- **OSV**: `POST /api/admin/osv/sync` (incremental) and `POST /api/admin/osv/bootstrap` (`--bootstrap-if-needed` semantics). The monolith topology calls the runners from `createSyncRunners` (`src/sync-scheduler.ts`) in-process behind the existing advisory lock, so a click and the cron can never overlap. In split topology the API process has no runner; the route enqueues a job the worker picks up, or returns `409 not_available_in_split` with the CronJob name to run. Decide which when implementing; the sentence on the button must match.
- **Feeds**: `POST /api/admin/feeds/:feed/sync` for `epss`, `kev`, `artifacthub`, same topology rule.
- **Image GC now**: `POST /api/admin/images/gc`, same path the nightly sweep takes (`deleteOrphanedImages`), returning the count collected.
- **Fleet rescan**: `POST /api/admin/rescan` calling `enqueueRescansAfterMirrorChange`'s enqueue path for every image with an SBOM. This is the recovery after a matcher fix; today it needs a mirror change to happen.

Every action writes an `activity_events` row? No: the feed carries changes to findings, not operator actions. Log them at `info` with the acting user id instead.

Acceptance: the removed "admin-only triggers that had no caller" (`routes/vulnerability.routes.ts` comment) now have a caller, and no trigger can run concurrently with its cron.

### Phase 5: fewer tabs, people in one place

- Group the tab strip into sections on wide screens (`Health`: Overview, System, Jobs · `Data`: Images, Explorer · `Advisories`: Vulnerabilities, Matcher, OSV Sync, Feeds · `People`: Users, Organizations, Feedback · `Index`: Chart Index). `TabBar` gains an optional `group` per item; the mobile strip stays flat.
- Users tab: add "Make platform admin" / "Revoke platform admin" on existing accounts, including OIDC and OAuth ones, through `PATCH /api/admin/users/:id` on the BFF (the client owns `auth.users.is_admin`). Refuse revoking the last admin. When `AUTH_OIDC_ADMIN_GROUP` is set, show that the flag is re-evaluated at sign-in so a manual grant to a group-managed account does not survive the next login.
- Users tab in community: show each account's org role (owner / admin / member) from `org_members`, with a link to the Members tab of organization settings where it is changed. One place to see people; roles still change where they live.
- Explorer: link from `/images/[id]` component rows into `ExplorerComponentDetail` for admins, since match provenance is the Explorer's one thing the image page does not show.

## Out of scope

- Cluster add / key mint in community (edition gate, stays 403).
- Any change to `activity_events`, findings counting or the risk model.
- A separate community UI package or route.
- The Chart Index and Feedback tabs.

## Documentation to update with the change

- `docs/ARCHITECTURE.md` § client shell: the admin page's tab list and the capability-gating rule.
- `docs/authorization-matrix.md`: the new `/api/admin/*` routes (count goes from 19) and the admin grant endpoint.
- `docs/self-hosting/README.md`: a short "The administration page" section pointing at System and the actions.
- `client/CLAUDE.md`: the explicit BFF routes list if `admin/system` or `admin/users/[id]` are added.

## Open questions

- Phase 2, versions: read the client version in the root layout and pass it through `RuntimeConfig`, or expose a BFF route? Prefer `RuntimeConfig`; it is already the channel for `scannerChartVersion`.
- Phase 4, split topology: enqueue-as-job or refuse-with-instructions? Enqueue is the better product; refuse is the smaller change. Decide before the OSV trigger lands, since the Feeds triggers follow it.
- Phase 3: does the cloud Overview keep the tenant stat grid at the top, or move it below the pipeline? This plan says below; the cloud operator may prefer the opposite.

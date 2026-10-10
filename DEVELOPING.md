# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

StackRadar is a SBOM (Software Bill of Materials) vulnerability tracking platform. It is a single git repository containing two **independent** apps — there is no root `package.json` and no pnpm workspace; each app is its own pnpm project with its own lockfile, so run `pnpm` commands from inside the app directory:

- `server/` — Express.js 5 backend API
- `client/` — Next.js 16 frontend + BFF (Backend-for-Frontend)

The marketing site (stackradar.io), the public chart index
(charts.stackradar.io) and the launch video live in their own
repositories (`lockdep/stackradar-landing`, `lockdep/stackradar-charts-index`,
`lockdep/stackradar-private`) since the repo split of 10 Oct 2026
(open-source plan step 09). The chart index talks to this server only over
`POST /internal/match` (`docs/contracts/match-endpoint.md`).

## The model — read before designing anything

- **[ADR 0004](docs/adr/0004-image-as-the-unit-of-identity.md)** — SBOMs and
  findings key on an **image**, not a workload. The model is
  `clusters → namespaces → workloads → workload_containers` plus `images`,
  `helm_releases` (what packaged a workload) and `gitops_applications` (what
  delivers it). The `projects` tree (`type: "project" | "group"`),
  `discovered_workloads` and `sboms.isCurrent` are gone.

  Three invariants everything else rests on (the first is
  **[ADR 0006](docs/adr/0006-images-are-cluster-scoped.md)**, which reversed
  ADR 0004's original sharing invariant):

  - **`images` is cluster-scoped: identity is `(cluster_id, digest)`.** An
    image, its SBOM and its findings belong to exactly one cluster and one
    org (`images.org_id`, denormalised, is the tenancy check). Nothing derived
    from an uploaded SBOM is ever shared across clusters — that is what makes
    SBOM poisoning and the scanned-digest oracle impossible rather than
    detected. Every SBOM upload requires a cluster-scoped API key.
  - **One SBOM per image**, enforced by `sboms_image_id_unique` — which now
    means one SBOM per digest per cluster. There is no "which SBOM" question
    left to answer; `?replace=true` on the upload is the supersede path.
  - **Deployment context never touches `sboms`.** Tag, ref, namespace, release,
    labels all live on `workload_containers` and its parents. `sboms` carries
    only facts about the document itself (plus `scanner_version` provenance).

- **[docs/contracts/inventory-v3.md](docs/contracts/inventory-v3.md)** — the
  `POST /v1/inventory` wire format. It is the **primary write path** for
  `namespaces`, `workloads`, `workload_containers`, `helm_releases` and
  `gitops_applications`, not a progress hint. Both repos encode it, so change
  the contract first.

  Two invariants it adds to the ones above:

  - **Packaging and delivery are separate relations.** ArgoCD commonly deploys
    *via* Helm, so a workload legitimately has both, and a single `source`
    discriminator would force a choice between two true answers — the chart
    version is what a CVE report cites, the Argo app is where the fix is made.
  - **"None" is never "unknown".** `namespaces.labels`, `workloads.kind` and
    `clusters.owner_metadata_collected` each carry a null that means "we could
    not look". Collapsing any of them turns a permissions failure into a
    confident false statement about a customer's cluster.
- **[ADR 0005](docs/adr/0005-risk-is-two-layers.md)** and
  **[ADR 0007](docs/adr/0007-aggregate-risk-is-an-unbounded-sum.md)** — the
  risk score. Two layers: a generated 0–100 column on `vulnerabilities` that is
  a pure function of CVSS × EPSS × KEV (ADR 0005), and an **unbounded sum** of
  those finding risks per image, workload, release, cluster or org (ADR 0007,
  which replaced ADR 0005's bounded fold). The sum composes; a rollup's colour
  band comes from its *worst finding*, never from the total. Read both before
  touching anything that reports a priority — they record why exposure is
  *not* in the number and why the aggregate is a magnitude, not a ranking.

- **[docs/proposals/README.md](docs/proposals/README.md)** — the ordered
  backlog. The model cutover is done; ranking and base-image recommendation
  phases 1–2 are done; remediation is the umbrella over them, notifications and
  the rest.

StackRadar is in production (app.stackradar.io) and, once public, in
self-hosted installs we cannot see. Every schema change ships as a forward
migration that works on a populated database; destructive changes need a
two-release deprecation.

## Commands

### Server (`/server`)
```bash
pnpm dev              # Start with hot reload (tsx watch)
pnpm build            # Compile TypeScript
pnpm test             # Run tests (Vitest)
pnpm test:watch       # Watch mode
pnpm test:coverage    # Coverage report
pnpm db:generate      # Generate Drizzle migrations
pnpm db:migrate       # Run migrations (drizzle-kit; local only — see Database Setup)
pnpm db:studio        # Open Drizzle Studio
pnpm db:up            # Start PostgreSQL via Docker
pnpm db:down          # Stop PostgreSQL
pnpm db:reset         # Reset DB (runs scripts/reset-db.sh)
pnpm worker           # Start job worker process (split topology; the monolith runs it inside `pnpm dev`)
pnpm worker:once      # Process one batch and exit
pnpm osv-sync         # Run OSV vulnerability sync CLI
pnpm epss-sync        # Sync FIRST.org EPSS exploitation probabilities
pnpm kev-sync         # Sync the CISA Known Exploited Vulnerabilities catalogue
pnpm osv-schema:check # Check the vendored OSV schema against ossf/osv-schema
pnpm osv-schema:sync  # Vendor the upstream OSV schema and update its lock
```

### Client (`/client`)
```bash
pnpm dev              # Start Next.js dev server (port 3000)
pnpm dev:pretty       # Dev with pino-pretty log formatting
pnpm build            # Build Next.js
pnpm lint             # ESLint
pnpm db:generate      # Generate auth schema migrations
pnpm db:migrate       # Migrate auth tables (drizzle-kit; local only — see Database Setup)
pnpm db:migrate:boot  # The in-image migrator (scripts/migrate.mjs): same chain, under the boot advisory lock
pnpm tokens:check     # Check theme.css against @primer/primitives (CI-enforced)
pnpm tokens:sync      # Rewrite theme.css from @primer/primitives
pnpm tokens:find      # Look up a Primer token
```

The `.github/workflows/primer-token-drift.yaml` workflow runs `tokens:check`
for `client/` on every pull request touching its theme files — a hand-edited
`theme.css` fails CI.

The landing site vendors a handful of the client's presentational components
(`client/src/components/ui/{EntityIcon,SortIcon,StatPanel,Table,TrendDelta,VulnerabilityBadge}.tsx`
and `client/src/lib/severity.ts`); its own CI checks out this repo and fails
when a copy no longer matches. A change to one of those files is a change
the landing repo has to sync (`pnpm dashboard:sync` there).

### Self-hosted quickstart (`/deploy/compose`)
```bash
docker compose -f deploy/compose/docker-compose.yml up -d   # the published images, fixture secrets, ports on 127.0.0.1
make -C deploy/compose quickstart                           # rotate the fixtures with openssl, then up
docker compose -f dev/docker-compose.yml up -d              # same file on the :snapshot images from main
```

The Compose quickstart (open-source plan step 07) is the laptop try-out of
the community edition: Postgres + server (monolith) + client, migrations on
boot, no scanner (that needs a cluster — the Helm chart, step 08). The
walkthrough is `docs/self-hosting/docker-compose.md`. The root
`docker-compose.yml` is still the *developer's* Postgres for `pnpm dev`.

### Helm chart (`../helm-charts`, a separate repository)

The community edition's real install is `charts/stackradar` in
`lockdep/helm-charts` (open-source plan step 08): server + client +
bundled Postgres + the scanner as a subchart, monolith by default, no
generated secrets (public fixtures in `values.yaml`, `NOTES.txt` warns).
`docs/self-hosting/helm.md` is the walkthrough. The chart reads the
contracts this repo defines — `MIGRATE_ON_START` / `MIGRATE_EXIT_AFTER`,
`BOOTSTRAP_CLUSTER_*`, `TOPOLOGY`, `OSV_ECOSYSTEMS`, the `*_CRON` schedules,
`/api/health/{live,ready}` on 3001 (server) and 3000 (client), the
`AUTH_*` tuples — so a change to any of them is a chart change too.

### Running tests for a single file (server)
```bash
cd server && pnpm vitest run src/path/to/file.test.ts
```

## Architecture

### Request Flow

Browser → Next.js client (port 3000) → Next.js BFF API routes (`/client/src/app/api/`) → Express backend (port 8080)

Authentication occurs at the Next.js layer (Auth.js v5 with GitHub/Google OAuth, database sessions). The BFF is a single catch-all route (`client/src/app/api/[...path]/route.ts`) that adds an `INTERNAL_SERVICE_KEY` header when proxying to Express; only Auth.js, health and `users/setup` have explicit route files. (`client/src/proxy.ts` is the Auth.js page-route gate — Next 16's rename of `middleware.ts` — not the BFF proxy.)

Public endpoints (the `/v1/*` routes) bypass the BFF and are called directly by the **StackRadar scanner agent** running inside a customer's Kubernetes cluster, authenticating with an API key (`X-API-Key`) and reporting its version via `X-Scanner-Version`.

The agent does two things:

- **`POST /v1/inventory`** — everything its pod informer can see, as a nested
  tree of namespaces, workloads and containers, plus the Helm releases that
  claim them. Each report is a **full set replacement** for one cluster, and the
  cluster comes from the API key rather than the body. It is the primary write
  path for the whole deployment side of the model, and it is also what lets the
  Dashboard show discovered-vs-scanned progress before the first SBOM lands.
  Requires a cluster-scoped key. See
  [docs/contracts/inventory-v3.md](docs/contracts/inventory-v3.md).
- **`POST /v1/sboms/upload/cyclonedx`** — one SBOM per image, where an image
  is a digest **as seen by one cluster** (ADR 0006). Before pulling anything it
  asks `GET /v1/sboms/check?imageDigest=` whether **this cluster** has already
  scanned the digest — one image across five namespaces of a cluster is still
  one pull, one syft run and one matching pass, but nothing is shared across
  clusters. Both endpoints require a cluster-scoped key; workload identity on
  the upload stays optional. `?replace=true` supersedes the cluster's existing
  SBOM for the image (recovery from a bad scan).

Coverage (`GET /api/clusters/:id/coverage`) is one `LEFT JOIN` from
`workload_containers` to the SBOM of the image each references, so
`scanned <= discovered` holds by construction rather than by a filter every
call site had to remember.

### Database Setup

**One PostgreSQL database**, two Drizzle projects (open-source plan step 05,
10 Oct 2026; supersedes ADR 0003's two databases):
- `public` schema: the server's application data (images, SBOMs, vulnerabilities, the Kubernetes inventory, orgs, jobs) — schema in `/server/src/db/schema/`, journal `drizzle.__drizzle_migrations`.
- `auth` schema: the client's Auth.js tables (users, sessions, accounts, verification_tokens) — schema in `/client/src/db/schema/` (`pgSchema("auth")`), journal `auth.__drizzle_migrations` (`client/drizzle.config.ts` `migrations`).

Both apps read the same `DATABASE_URL`. The server's `public.users` and the
client's `auth.users` are different tables (the server mirrors identities by
id); nothing in either Drizzle project references the other's schema. Docker
Compose runs a single PostgreSQL 18 instance on port **5444** (non-standard)
with the one database created by `scripts/init-db.sql`.

**How migrations are applied.** Self-hosted installs apply them at startup:
`MIGRATE_ON_START=true` on the server (`src/db/migrate.ts`, programmatic
`migrate()` from `drizzle/`) and on the client (`docker-entrypoint.sh` →
`scripts/migrate.mjs` before `next start`). Both take the same Postgres
session advisory lock (`MIGRATION_LOCK_KEY`, checked for drift by
`scripts/check-cross-app-constants.mjs`), so any number of replicas of either
app can start together: one migrates, the rest wait and find nothing to do.
`MIGRATE_EXIT_AFTER=true` makes the same image a one-shot initializer that
migrates and exits 0. The cloud sets neither flag and keeps its ArgoCD
PreSync Jobs (`npx drizzle-kit migrate`); both paths write the same journal.

> [!IMPORTANT]
> **Do not apply migrations against a shared database.** On the dev and prod clusters migrations are applied exclusively by the deploy (ArgoCD PreSync Jobs); never run `pnpm db:migrate`, `drizzle-kit migrate`/`push` or `pnpm db:reset` against them, and never set `MIGRATE_ON_START` on a cloud Deployment. Generating migration *files* (`pnpm db:generate`) is fine — that's authoring, not applying. Your own local Compose database is yours: `MIGRATE_ON_START=true pnpm dev` (server) or `pnpm db:migrate:boot` (client) brings it up to date. If a schema change needs to take effect in an environment, hand off the generated migration to the normal deploy flow.

### Server Layer Pattern

Express routes → Controllers → Repositories (Drizzle ORM queries). Services handle cross-repository business logic. Zod schemas in `/server/src/schemas/` validate request bodies.

### Key Backend Systems

**Job Queue** (`/server/src/jobs/job-worker.ts`): Custom polling worker that reads from the `jobs` table. Processes SBOM parsing, vulnerability scanning, and scheduled scans. In the **split** topology (the cloud) it runs as its own process, `dist/src/worker.js`; in the **monolith** topology (the community default, `src/topology.ts`) the API server starts it in-process after it listens.

**Topology** (`/server/src/topology.ts`, open-source plan step 06): `TOPOLOGY=monolith|split`, unset follows the edition (community → monolith, cloud → split). The monolith server process also runs `src/sync-scheduler.ts` — in-process crons for the OSV incremental sync (hourly), the OSV bootstrap check (at start-up and every 12 h; this is what gives a fresh install a mirror without anyone running a command), EPSS and KEV (daily, forced once right after a bootstrap) and the Artifact Hub mirror (nightly, unless `ARTIFACT_HUB_SYNC_ENABLED=false`). Replicas are safe: the job queue claims with `SKIP LOCKED`, the OSV sync holds a session advisory lock per run, EPSS and KEV take a transaction advisory lock on their apply (`lib/sync-lock.ts`). The cloud keeps its worker Deployment and CronJobs and starts nothing here. A community install is `server` + `client` + the scanner.

**OSV mirror scope** (`/server/src/osv-sync/ecosystems.ts`): `OSV_ECOSYSTEMS` is a comma-separated allow-list of OSV directory names (`Alpine,Debian,Red Hat,npm`; case-sensitive, spaces included). Unset means the community default list, or everything on the cloud; `*` means everything. A scoped bootstrap pulls one `<dir>/all.zip` per ecosystem and the incremental sync ignores entries outside the scope. `osv_sync_state.ecosystems` records what the live generation carries; `--bootstrap-if-needed` rebuilds when the configured list was widened, because nothing else can add an ecosystem to a built mirror. See `server/src/osv-sync/README.md` § *Scoping the mirror* and the step-06 measurements in the plan.

**OSV Sync** (`/server/src/osv-sync/`): Mirrors the OSV.dev vulnerability database locally (~300k+ records). Has two modes: full bootstrap (downloads ZIP archives) and incremental (polls API for recent changes). See `/server/src/osv-sync/README.md` for details.

**Vulnerability Matching**: After SBOM ingestion, components are matched against the mirrored advisories in `vulnerabilities` / `vulnerability_affected_packages` using PURL, CPE, and name-version lookups. Results stored in `component_vulnerabilities`. One matching pass per image, not per place it runs.

**Ranking findings**: `server/src/db/risk-model.ts` is the single definition of
what a finding is *worth*, as `findings.ts` is of what counts. Two layers, and
the split is forced by ADR 0004: `vulnerabilities.risk_score` is a
`GENERATED ALWAYS AS (…) STORED` column over CVSS, EPSS and KEV — a pure function
of the advisory, so the daily EPSS sync is its recomputation and drift is
unrepresentable — and `db/risk.ts` sums sets of those into an **unbounded**
score for an image, workload, release, cluster or org at read time (ADR 0007).
The sum composes, but each fold still runs from raw findings — one query, and
the distinct step against double-mounted digests is mandatory. A rollup's band
is its worst finding's band, never a threshold on the total. Exposure (pods,
age, init flag) is deliberately in neither layer. See
[ADR 0005](docs/adr/0005-risk-is-two-layers.md) and
[ADR 0007](docs/adr/0007-aggregate-risk-is-an-unbounded-sum.md).

**Upgrade recommendations**: `services/upgrade-recommendation.service.ts`
answers "which tag should this move to, and what does that buy" on two axes —
newer scanned tag of the same repository, and newer version of the same chart.
Both are org-scoped by a *required* argument, because tags live on
`workload_containers` and are tenant data even though `images` is not.
`lib/image-tags.ts` decides which tags are comparable and refuses the rest; its
job is refusal, not ordering.

**Remediation**: `services/remediation.service.ts` is the Fix tab's engine —
the per-image rollup with its fixable / awaiting-fix / EOL split
(`lib/eol-releases.ts` owns the EOL verdicts; unknown is never EOL), the
delivery commands (`lib/remediation-commands.ts` — Helm / ArgoCD / kubectl,
refusal-first), and the **issue** lifecycle (`issues` table — scopes `image`,
`release`, `finding`) whose `verified` state is written only by the sweeps —
the inventory sweep for image/release issues, the post-scan sweep for finding
issues — never by a request; the user's own exit is `closed`, with a
mandatory reason. An issue's risk is folded at read time, never stored.
Suppression (`finding_states`) requires owner, reason and expiry, keys on the
cross-image finding identity, and is excluded only on the Fix surface — the
risk score still counts suppressed findings on purpose. See
[docs/proposals/remediation-workflow.md](docs/proposals/remediation-workflow.md)
and [docs/proposals/issues-workflow.md](docs/proposals/issues-workflow.md).

**Activity feed**: `activity_events` carries **changes, never inventory** —
one event per change, never one per finding. The Feed page (`/feed`,
`GET /api/feed`) is its reader; day grouping and the folding of repeats
happen in the view. Two write
sites feed it: the inventory report diffs the cluster's containers per
**slot** (workload + container name) against the state it is about to
replace (`lib/container-slots.ts`, pure; `container-history.repository.ts`
inside the inventory transaction) and records intervals in
`workload_container_history` — the past of `workload_containers`, which is
left untouched — plus `container.*` events, a move carrying the finding delta
between its two digests from `finding-delta.ts`; and the scan job brackets
itself with `comparableFindings` and emits one `scan.findings-changed` per
image per scan (`cause: "mirror"` — the world changed — or `"upload"` — we
did). Retention runs on the plan clock with the other history tables. See
[docs/proposals/activity-feed.md](docs/proposals/activity-feed.md).

**Counting findings**: `server/src/db/findings.ts` is the single definition of what counts as a finding, and every surface that reports a number goes through `collapsedFindings`. Findings key on `imageId`, so a caller scoping to an org or cluster uses `deployedImages(orgId)` / `deployedImagesInCluster(clusterId)` — `EXISTS` predicates, not joins, because joining `workload_containers` would multiply every finding by the number of places its image runs.

### Client Structure

Real Next.js routes under `app/(app)/` share a shell layout with the sidebar: the dashboard at `/`, plus `/vulnerabilities` (every cluster's Vulnerabilities tab folded into one; the dashboard's severity cards link into it), `/packages` (likewise for the Packages tabs; the dashboard's Packages card links into it), `/containers` (every cluster's Containers tab as one flat worst-first list, with `?cluster=` and `?namespace=` filters; the dashboard's Running containers card links into it), `/images` (the same fleet as one row per image, worst first, with `?cluster=`), `/clusters` (and `/clusters/[id]` with tab sub-routes), `/images/[id]`, `/releases/[id]`, `/admin`, `/org-settings` and `/profile`. Each route renders a view component from `/client/src/views/`; `/login` and `/invite/[token]` live outside the shell. `OrganizationProvider` wraps the app to track the active org context.

The workloads list always groups by **namespace**, over flat `workload_containers` rows. Grouping is a read-time choice, not a stored hierarchy, which is why the list needs no tree walk and why a release or an image can have its own page (`/releases/[id]`, `/images/[id]`) without becoming a fourth sidebar section.

## Environment Variables

### Server (`.env`)
```
DATABASE_URL=postgresql://...
PORT=8080
INTERNAL_SERVICE_KEY=<shared secret matching client>
API_KEY_ENCRYPTION_KEY=<openssl rand -hex 32>   # required: encrypts scanner keys at rest so admins can reveal them (lib/api-key-vault.ts)
STACKRADAR_EDITION=community                    # or `cloud`; unset means community (src/edition.ts)
BOOTSTRAP_CLUSTER_ID=<uuid>                     # community only, with the next: the install's own cluster and the
BOOTSTRAP_CLUSTER_API_KEY=<key>                 # scanner key it authenticates with, seeded at start-up (services/default-org.service.ts)
MIGRATE_ON_START=true                           # self-hosted: apply the Drizzle chain before listening (src/db/migrate.ts); the cloud leaves it unset
MIGRATE_EXIT_AFTER=true                         # migrate and exit 0 — the same image as a one-shot initializer Job; implies the previous
TOPOLOGY=monolith                               # or `split`; unset follows the edition (community → monolith, cloud → split) (src/topology.ts)
OSV_ECOSYSTEMS=Alpine,Debian,Red Hat,npm        # OSV directories the mirror carries; unset = community default list / everything on the cloud; `*` = everything
```

### Client (`.env.local`)
```
DATABASE_URL=postgresql://...  # The SAME database as the server's; this app uses its `auth` schema
MIGRATE_ON_START=true          # self-hosted: scripts/migrate.mjs runs before `next start` (docker-entrypoint.sh); MIGRATE_EXIT_AFTER=true migrates and exits
EXPRESS_API_URL=http://localhost:8080
INTERNAL_SERVICE_KEY=<shared secret matching server>
AUTH_SECRET=<random>
AUTH_GITHUB_ID=<oauth app id>
AUTH_GITHUB_SECRET=<oauth app secret>
```

## Skills

Domain knowledge lives as skills in `.claude/skills/`. These auto-trigger based on their descriptions when you work in a relevant area — no need to invoke them manually.

### Project domain skills

| Skill | Triggers when working on |
|---|---|
| `project-architecture` | Routes, controllers, services, BFF proxies, auth middleware |
| `database-drizzle` | Schema definitions, migrations, repositories |
| `testing-patterns` | Writing tests, fixtures, Testcontainers setup |
| `sbom-cyclonedx` | SBOM parsing, CycloneDX, PURL handling |
| `ui-theming` | Client UI colour, Tailwind classes, badges, dark mode |
| `osv-vulnerabilities` | OSV sync, vulnerability matching, CVSS scoring |
| `deployment-k8s` | Kubernetes manifests, ArgoCD, Docker, docker-compose |

### Stripe skills (managed; tracked in `skills-lock.json`)

`stripe-best-practices`, `stripe-projects`, `upgrade-stripe` — provisioned from `docs.stripe.com`; their integrity is verified via `skills-lock.json`.

### General engineering skills

`tdd`, `diagnose`, `triage`, `grill-me`, `improve-codebase-architecture`, plus `zoom-out` and `grill-with-docs` (manual-only — invoke explicitly, they don't auto-trigger).

## Database Schema Reference

Full schema documentation with relationships: `/server/src/db/SCHEMA.md`

Key tables: `images`, `sboms`, `components`, `component_vulnerabilities`, `vulnerabilities`, `vulnerability_affected_packages`, `namespaces`, `workloads`, `workload_containers`, `helm_releases`, `clusters`, `organizations`, `org_members`, `api_keys`, `jobs`

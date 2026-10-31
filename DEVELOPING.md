# Hacking on StackRadar

Want to work on StackRadar? Here is what you need to know to get started.

> Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
> [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) as well, and
> [`AGENTS.md`](AGENTS.md) before designing anything: it is the domain
> model and the invariants every change has to respect. (`CLAUDE.md` is a
> symlink to it, so coding agents read the same file.)

## Repositories

StackRadar is four repositories:

* [lockdep/stackradar](https://github.com/lockdep/stackradar) (this one):
  the server and the web client, the Compose quickstart and the
  self-hosting docs.
* [lockdep/helm-charts](https://github.com/lockdep/helm-charts): the
  `stackradar` Helm chart, which installs the two apps, a bundled Postgres
  and the scanner.
* [lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner):
  the Go agent that runs inside a cluster, generates SBOMs with Syft and
  reports to the server's `/v1` endpoints. It has its own chart.
* [lockdep/stackradar-cli](https://github.com/lockdep/stackradar-cli): the
  zero-signup `stackradar scan` CLI.

This document covers this repository. The two apps in it are
**independent** pnpm projects, each with its own lockfile: there is no root
`package.json` and no workspace, so every `pnpm` command below runs inside
`server/` or `client/`.

| App | Stack | Purpose |
|:--|:--|:--|
| [`server/`](server/) | Express 5, Drizzle, PostgreSQL | The API, the job worker, the OSV / EPSS / KEV sync and the vulnerability matching |
| [`client/`](client/) | Next.js 16 | The product UI and its BFF proxy; Auth.js sessions in the `auth` schema of the same database |

## Prerequisites

* Node.js 22 (the images are built on `node:22-alpine`)
* pnpm, at the version each app's `package.json` names in `packageManager`
  (`corepack enable` picks it up; so does `pnpm/action-setup` in CI)
* Docker, for the local PostgreSQL and for the server's test suite
  (Testcontainers)
* A Kubernetes cluster is **not** needed to work on the apps. To see the
  scanner in action, a kind cluster and the Helm chart are the shortest
  path (see [docs/self-hosting/helm.md](docs/self-hosting/helm.md)).

After cloning, point git at the repository's hooks once:

```sh
git config core.hooksPath .githooks
```

The one hook there, `prepare-commit-msg`, appends the `Signed-off-by`
trailer CONTRIBUTING.md requires, so a plain `git commit` passes the DCO
gate without remembering `-s`.

## Core Technologies

| Technology | Purpose |
|:--|:--|
| [Express 5](https://expressjs.com/) | The server's HTTP layer: routes → controllers → services → repositories |
| [Drizzle ORM](https://orm.drizzle.team/) | Schema, queries and migrations, one project per app |
| [PostgreSQL 18](https://www.postgresql.org/) | The one database; the server owns `public`, the client owns `auth` |
| [Zod](https://zod.dev/) | Request validation (`server/src/schemas/`) |
| [Vitest](https://vitest.dev/) + [Testcontainers](https://testcontainers.com/) | The test suites; the server's run against a real Postgres |
| [Next.js 16](https://nextjs.org/) (app router) | The client and its BFF (`client/src/app/api/[...path]/route.ts`) |
| [Auth.js v5](https://authjs.dev/) | Sessions; local password, OIDC, GitHub and Google providers |
| [Tailwind](https://tailwindcss.com/) + [Primer primitives](https://primer.style/primitives/) | The client's theme (`theme.css` is generated; see Testing) |
| [pino](https://getpino.io/) | Structured logging in both apps |

## Building

```sh
cd server && pnpm install && pnpm build     # tsc → dist/
cd client && pnpm install && pnpm build     # next build
```

Neither build is needed for development; `pnpm dev` runs from source in
both apps. The client's production build is what the image runs, and it is
also the quickest way to find a type error the dev server tolerated.

## Running

The local Postgres is the root `docker-compose.yml`: one PostgreSQL 18 on
port **5444** (deliberately non-standard) with the one database created by
`scripts/init-db.sql`. Both apps start it with `pnpm db:up`.

```sh
cd server
cp .env.example .env            # local defaults that match the Compose Postgres
pnpm install
pnpm db:up                      # PostgreSQL on :5444
MIGRATE_ON_START=true pnpm dev  # API on :8080, applies the migration chain first

cd client
cp .env.example .env.local
pnpm install
pnpm dev                        # UI on :3000, proxies to :8080
```

On first start with local login on (the community default) the client
creates the bootstrap admin `admin@stackradar.local` / `admin`, and the
server seeds the default organisation and, with the `BOOTSTRAP_CLUSTER_*`
pair set, the install's own cluster. Log in, change the password, and the
dashboard is yours. There is nothing in it until an SBOM arrives; the
Compose walkthrough's two `curl` lines upload one
([docs/self-hosting/docker-compose.md](docs/self-hosting/docker-compose.md)
§ "Upload an SBOM"), and they work against `pnpm dev` the same way.

What each app reads from its environment is listed in
[AGENTS.md § Environment Variables](AGENTS.md#environment-variables).
The ones you will set:

| Variable | Where | What |
|:--|:--|:--|
| `DATABASE_URL` | both | The same database; the client uses its `auth` schema. Must carry an explicit `sslmode` (`prefer` is fine locally; production refuses anything weaker than `require`). |
| `INTERNAL_SERVICE_KEY` | both | The shared secret on every BFF → server call. Any string, the same on both sides. |
| `API_KEY_ENCRYPTION_KEY` | server | 64 hex characters (`openssl rand -hex 32`); encrypts scanner keys at rest. Set it once. |
| `AUTH_SECRET` | client | `openssl rand -base64 32` |
| `MIGRATE_ON_START=true` | both | Apply the app's migration chain at start-up. Only ever against a database you own. |
| `STACKRADAR_EDITION` | both | `community` (unset) or `cloud`. Leave it unset. |
| `BOOTSTRAP_CLUSTER_ID`, `BOOTSTRAP_CLUSTER_API_KEY` | server | The install's own cluster and the scanner key that uploads to it, seeded at start-up. The `.env.example` pair is fine locally. |
| `APP_URL` | server | Where the client is reachable from a browser (`http://localhost:3000` locally); links in alerts point here. |
| `TOPOLOGY` | server | `monolith` (worker and sync crons in-process; the community default) or `split`. |
| `LOG_LEVEL` | both | pino level, `info` by default; `debug` when chasing something. |
| `OSV_ECOSYSTEMS` | server | See *Skipping the OSV bootstrap* below. |

### The whole product without building it

```sh
docker compose -f dev/docker-compose.yml up -d    # the :snapshot images from main
docker compose -f deploy/compose/docker-compose.yml up -d   # the latest release
```

[`dev/docker-compose.yml`](dev/docker-compose.yml) is the Compose
quickstart on the `:snapshot` tag that CI pushes from every merge to
`main`: Postgres, server (monolith) and client, migrations on boot, fixture
secrets, ports bound to `127.0.0.1`. It is for trying the product, not for
developing it; it builds nothing from your checkout — `scripts/fresh-local.sh`
(§ *Building Container Images*) is the same stack on images built from it.

### Common server commands

```sh
pnpm dev              # tsx watch src/index.ts
pnpm build            # tsc
pnpm typecheck        # tsc --noEmit
pnpm format           # prettier --write (CI runs format:check)
pnpm test             # Vitest, against a Testcontainers PostgreSQL
pnpm db:generate      # author a Drizzle migration from a schema change
pnpm db:migrate       # apply the chain with drizzle-kit (local only)
pnpm db:studio        # Drizzle Studio
pnpm db:reset         # drop and recreate the local database
pnpm worker           # the job worker as its own process (split topology; the monolith runs it inside `pnpm dev`)
pnpm osv-sync         # the OSV sync CLI (bootstrap, incremental, --bootstrap-if-needed)
pnpm epss-sync        # FIRST.org EPSS
pnpm kev-sync         # CISA KEV
pnpm osv-schema:check # the vendored OSV schema against ossf/osv-schema
pnpm knip             # dead exports
```

### Common client commands

```sh
pnpm dev              # next dev on :3000 (pnpm dev:pretty for pino-pretty)
pnpm build            # next build
pnpm lint             # eslint
pnpm format           # prettier --write (CI runs format:check)
pnpm test             # Vitest
pnpm db:generate      # author an auth-schema migration
pnpm db:migrate:boot  # the in-image migrator (scripts/migrate.mjs), under the boot advisory lock
pnpm tokens:check     # theme.css against @primer/primitives (CI-enforced)
pnpm tokens:sync      # rewrite theme.css from @primer/primitives
pnpm admin:reset-password <email>   # the locked-out-admin path
pnpm knip             # dead exports
```

## Debugging

### Inspecting the database

There is one database. The server's tables are in the `public` schema and
its migration journal in `drizzle.__drizzle_migrations`; the client's
Auth.js tables are in the `auth` schema with their journal in
`auth.__drizzle_migrations`. Both apps connect with the same URL.

```sh
psql "postgresql://postgres:postgres@localhost:5444/server?sslmode=prefer"
# \dn           the schemas
# \dt           the server's tables
# \dt auth.*    the client's tables
```

`pnpm db:studio` in either app opens Drizzle Studio on that app's half.
The schema reference with relationships is
[`server/src/db/SCHEMA.md`](server/src/db/SCHEMA.md).

> [!IMPORTANT]
> Migrations are applied against the cloud's databases only by the deploy.
> Never run `pnpm db:migrate`, `drizzle-kit push` or `pnpm db:reset` against
> a database you do not own, and never set `MIGRATE_ON_START` on a cloud
> Deployment. Authoring migration files with `pnpm db:generate` is fine;
> applying them is a deploy.

### Skipping the OSV bootstrap

In the community edition the server process runs the sync scheduler
in-process (`TOPOLOGY=monolith`, the default), and the scheduler's first
act is to check whether the OSV mirror exists and bootstrap it if not: the
default ecosystem list is about 1.2 GB of downloads and 5 to 25 minutes.
For development, scope it:

```sh
OSV_ECOSYSTEMS=Alpine MIGRATE_ON_START=true pnpm dev
```

`Alpine` alone is a 40 MB, two-minute mirror that finds everything in an
Alpine-based image, which the SBOM fixture under `server/tests/fixtures/`
is. Widening the list later makes the next bootstrap check rebuild the
mirror. To run no sync at all, `TOPOLOGY=split` starts the API alone; the
feeds are then `pnpm osv-sync`, `pnpm epss-sync` and `pnpm kev-sync` by
hand, and the job worker is `pnpm worker`.

The admin area's **OSV** tab shows the mirror's state, the ecosystems it
carries against the configured list, and the recent runs;
`server/src/osv-sync/README.md` explains the sync's two modes.

### Health endpoints

`GET /api/health/live` and `GET /api/health/ready` on the server (port
3001 in the image, 8080 under `pnpm dev`) and the client (3000). Readiness
names the problem rather than the value: a refused database URL, a missing
variable, a half-configured sign-in provider.

## Testing

### Server

```sh
cd server
pnpm test                                        # everything
pnpm vitest run tests/integration/sboms/upload-sbom-tier.test.ts   # one file
pnpm test:watch
```

The suite runs against a real PostgreSQL 18 that Testcontainers starts
once per run (`tests/setup/global-setup.ts`), with the migration chain
applied, so Docker has to be up. Nothing mocks the database. Integration
tests `cleanAllData()` in `beforeEach`, seed with the helpers in
`tests/fixtures/seed-data.ts` and authenticate with
`createInternalHeaders()`; the server's own `CLAUDE.md` describes the
layer conventions a new route or table follows.

### Client

```sh
cd client
pnpm lint
pnpm test
```

Client tests are unit tests over `src/**/*.test.{ts,tsx}` and need no
database.

### End to end

```sh
cd e2e
pnpm install && pnpm exec playwright install chromium
pnpm test
```

Playwright over the Compose quickstart built from the checkout: three
containers (project `stackradar-e2e`, UI 3200, API 8280, Postgres 5446, so
it runs beside `pnpm dev` and `fresh-local.sh`), seeded through the
scanner API with the nginx SBOM fixture, driven through Chromium. The
stack stays up between runs; `pnpm stack:down` removes it. Nothing is
mocked, so it is the one suite that exercises sign-in, migrations on boot,
the BFF and the job worker together. [e2e/README.md](e2e/README.md) has
the layout and how to add a test.

### The gates a pull request runs

| Workflow | What it checks |
|:--|:--|
| `ci-test` | Both suites, `prettier --check` in both apps, the client lint, and the three drift scripts below |
| `cloud-boundary` | `node scripts/check-cloud-boundary.mjs`: every file under `server/src/cloud/` and `client/src/cloud/` carries the SPDX header, nothing outside does, and the AGPL core imports the cloud only at its designated mount points |
| `cross-app-drift` | `node scripts/check-cross-app-constants.mjs`: the few constants the client copies from the server (risk bands, plan limits, the migration lock key) still match |
| `dead-exports` | `pnpm knip` in each app |
| `dependency-licenses` | `node scripts/check-dependency-licenses.mjs`: every runtime dependency of each app carries a licence an AGPL-3.0 image may ship (runs when a manifest or lockfile changes; needs `pnpm install` first) |
| `primer-token-drift` | `pnpm tokens:check`: `client/src/app/theme.css` is still what `@primer/primitives` generates |
| `osv-schema-drift` | `node server/scripts/sync-osv-schema.mjs --verify`: the vendored OSV schema was not hand-edited (and weekly, that upstream has not moved) |
| `e2e` | `pnpm test` in `e2e/`: the Playwright suite over the Compose stack built from the checkout, Chromium only (runs when an app, the Compose files or `e2e/` change) |
| `snapshot` | Both images build (push disabled on a pull request) |
| `codeql` | GitHub CodeQL over `server/src` and `client/src` |
| `dco` | Every commit in the pull request carries a `Signed-off-by` trailer |

All of the drift scripts run on bare `node` from a bare checkout, so they
are cheap to run before pushing.

Two more workflows score the repository rather than a pull request:
`codeql` also runs weekly, and `scorecard` (OpenSSF Scorecard) runs on
every merge to `main` and weekly, publishing the result to
[scorecard.dev](https://scorecard.dev/viewer/?uri=github.com/lockdep/stackradar)
and its findings to Security → Code scanning. Code-Review and Fuzzing
are the two checks expected to score low.

Every action a workflow uses is pinned to a commit SHA, with the release
it corresponds to in a trailing comment (`uses: actions/checkout@d23441a… # v6.1.0`),
and nothing is piped from a URL into a shell. A tag can be moved; a
commit cannot, and the `publish` job holds the identity that signs the
images. Dependabot's `github-actions` entry bumps the SHA and the comment
together, so a new workflow only has to start out pinned.

## Building Container Images

```sh
docker build -t stackradar-server:local server/
docker build -t stackradar-client:local --target runner client/
```

Both Dockerfiles are multi-stage on `node:22-alpine`, pinned by digest,
and build for `linux/amd64` and `linux/arm64` (the server's `tools` stage
picks the `helm` and `syft` binaries and their checksums by `TARGETARCH`;
`docker buildx build --platform linux/arm64 …` builds the other one). The
server image listens on 3001 and the client on 3000; both run as a
non-root user with a read-only root filesystem in the chart. CI builds
the same way: `.github/workflows/snapshot.yaml` pushes the
`:snapshot` tag of `ghcr.io/lockdep/stackradar-server` and `-client` from
every merge to `main`, and `publish.yaml` the versioned, multi-arch tags
from a release tag. Both sign with Cosign. [RELEASING.md](RELEASING.md)
is the release process.

To run the whole product on what you just built, from an empty database:

```sh
scripts/fresh-local.sh                        # wipe, build both images, up, wait until healthy
scripts/fresh-local.sh --keep-data            # rebuild and restart, keep the database
OSV_ECOSYSTEMS=Alpine scripts/fresh-local.sh  # a 2-minute mirror instead of the default list
```

It runs the quickstart (`deploy/compose/docker-compose.yml`) with
[`dev/local-build.yml`](dev/local-build.yml) on top: the same Postgres and
fixture secrets, but the server and client images built from `./server`
and `./client` instead of pulled from GHCR, and ports of its own so that it
runs next to `pnpm dev`:

| | Port | Move it with |
|:--|:--|:--|
| UI | `127.0.0.1:3100` | `LOCAL_UI_PORT` |
| API | `127.0.0.1:8180` | `LOCAL_API_PORT` |
| Postgres | `127.0.0.1:5445` | `LOCAL_DB_PORT` |

The project name is `stackradar-local`, so its `down --volumes` cannot
reach the data of a snapshot or release quickstart on the same machine.
Sign in at <http://localhost:3100> with the fixture admin; the fixture
scanner key uploads an SBOM exactly as in
[docs/self-hosting/docker-compose.md](docs/self-hosting/docker-compose.md),
against port 8180. It is the way to see a first boot — migrations, the
default organisation, the fresh-install banner, the OSV import — on your
branch rather than on `main`'s snapshot.

## Documentation

Everything is Markdown in the repository; there is no build step.

* [`docs/self-hosting/`](docs/self-hosting/): the self-hoster's manual.
  Every page says which edition it applies to at the top. A behaviour
  change that a self-hoster can see is a change to one of these pages.
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the system end to end,
  with a design-decision index.
* [`docs/adr/`](docs/adr/): architecture decision records. A reversed
  decision gets a new ADR that says so; the old one stays.
* [`docs/contracts/`](docs/contracts/): the wire formats shared with the
  scanner (`inventory-v3.md`) and the chart index (`match-endpoint.md`).
  Both sides encode them, so change the contract first.
* [`docs/authorization-matrix.md`](docs/authorization-matrix.md): who may
  do what, per edition, with the file that decides it.

The Helm chart's README is generated by `helm-docs` from
`README.md.gotmpl` in the helm-charts repository; do not edit it by hand.

## Shared Feature Branches

Large changes are easier to review as a draft pull request opened early
than as one finished pull request opened late. If a change takes several
people, or needs user feedback before it is merged, ask a maintainer in
the issue for a shared `feat/<topic>` branch in this repository to raise
pull requests against instead of `main`; it follows the branch naming in
[CONTRIBUTING.md](CONTRIBUTING.md#pull-requests) and is subject to the
same review. Images are built from `main` and from releases only, so a
feature branch is tried with `pnpm dev` or a local image build.

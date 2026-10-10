# StackRadar

SBOM-based vulnerability tracking for Kubernetes. A scanner agent in the
customer's cluster reports its inventory and uploads CycloneDX SBOMs; the
platform mirrors OSV.dev, matches components against it, and ranks what to
fix first.

## Layout

Two independently deployed apps, each its own pnpm project:

| App | Stack | Purpose |
|---|---|---|
| [`server/`](server/) | Express 5 + Drizzle + PostgreSQL | API, job queue, OSV sync, vulnerability matching |
| [`client/`](client/) | Next.js 16 | Product UI + BFF proxy (Auth.js sessions) |

The scanner agent is [lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner),
the Helm chart is [lockdep/helm-charts](https://github.com/lockdep/helm-charts)
and the zero-signup CLI is [lockdep/stackradar-cli](https://github.com/lockdep/stackradar-cli).

## Where to start reading

- **[DEVELOPING.md](DEVELOPING.md)** — the working guide: the domain model
  and its invariants, commands, architecture, environment variables.
  (`CLAUDE.md` is a symlink to it, so coding agents read the same file.)
- **[CONTEXT-MAP.md](CONTEXT-MAP.md)** — how the three contexts relate, and
  where each one's `CONTEXT.md` and ADRs live.
- **[docs/adr/](docs/adr/)** — system-wide architecture decisions.
- **[docs/runbooks/](docs/runbooks/)** — operational snippets (DB access,
  registry login, scanner CA config, Stripe webhooks).

## Run it

### Kubernetes (Helm)

```sh
helm install stackradar oci://ghcr.io/lockdep/helm-charts/stackradar \
  --namespace stackradar --create-namespace
kubectl -n stackradar port-forward svc/stackradar-client 3000:3000
```

One command: the server, the UI, a bundled Postgres and the scanner,
already scanning the cluster it lands in. Open <http://localhost:3000>,
sign in as `admin@stackradar.local` / `admin`, change the password when
asked. The chart lives in
[lockdep/helm-charts](https://github.com/lockdep/helm-charts) and
[docs/self-hosting/helm.md](docs/self-hosting/helm.md) is the walkthrough
(fixtures to replace, Ingress, OIDC, leaving the bundled Postgres). The
first chart release ships with the first application release (open-source
plan step 14).

### Quickstart (Docker Compose)

```sh
curl -LO https://raw.githubusercontent.com/lockdep/stackradar/main/deploy/compose/docker-compose.yml
docker compose up -d
```

Open <http://localhost:3000>, sign in as `admin@stackradar.local` /
`admin`, and change the password when asked. The server builds its OSV
mirror in the background (allow 5–25 minutes depending on your connection;
the UI says so until it is done). Compose cannot run the scanner — it needs
a cluster — so upload an SBOM by hand to see findings:
[docs/self-hosting/docker-compose.md](docs/self-hosting/docker-compose.md)
has the two `curl` lines. To see your own cluster, use the Helm install; it
includes the scanner.

> [!WARNING]
> Every secret in that file is a public fixture and the ports bind
> `127.0.0.1`. Keep it on your machine, or run `make quickstart` from
> `deploy/compose/` to rotate the fixtures before the first start.

Resources: the server peaks at ~2 GB during the OSV import and Postgres
stays in the low single-digit GB with the default ecosystem list; the
whole OSV corpus (`OSV_ECOSYSTEMS=*`) is ~12 GB on disk and 2.5 GB of
downloads. `OSV_ECOSYSTEMS=Alpine` is a 40 MB, two-minute mirror for a
first look.

Images: `ghcr.io/lockdep/stackradar-server` and
`ghcr.io/lockdep/stackradar-client`, tagged `:<version>` and `:latest` per
release and `:snapshot` from `main` (`dev/docker-compose.yml` runs that).

## Developing

```bash
cd server && pnpm install && pnpm db:up && pnpm dev   # API on :8080
cd client && pnpm install && pnpm dev                 # UI on :3000
```

Each app has its own `.env` requirements — see the environment sections in
[DEVELOPING.md](DEVELOPING.md) and each app's `.env.example`. Both apps share one
database: the server owns `public`, the client's Auth.js tables live in its
`auth` schema. Self-hosted installs apply migrations at startup
(`MIGRATE_ON_START=true` on both apps); the cloud applies them in a deploy
Job. Locally, set `MIGRATE_ON_START=true` once against the Compose database
and never apply migrations against a shared environment by hand.

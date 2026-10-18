---
name: deployment-k8s
description: >-
  How StackRadar is built and deployed: the two Dockerfiles, the Compose
  quickstart, the Helm chart, the publish workflow and the environment each
  image reads. Use when working with Dockerfiles, docker-compose, Kubernetes
  resources, release images or environment configuration.
---

# Deployment & packaging

## What ships

| Artifact | Built by | Pulled by |
|---|---|---|
| `ghcr.io/lockdep/stackradar-server:<version>` | `.github/workflows/publish.yaml` from a release tag (amd64 + arm64, cosign-signed, SBOM attached) | the Helm chart, `deploy/compose/docker-compose.yml` |
| `ghcr.io/lockdep/stackradar-client:<version>` | same | same |
| `…:snapshot` of both | `.github/workflows/snapshot.yaml` on every merge to `main` | `dev/docker-compose.yml` |
| Helm chart `oci://ghcr.io/lockdep/helm-charts/stackradar` | the `lockdep/helm-charts` repository | self-hosted installs (`docs/self-hosting/helm.md`) |

Versioned tags are never rebuilt; `RELEASING.md` is the process. The
scanner is its own chart and repository (`lockdep/stackradar-scanner`).

## Dockerfiles

Both are multi-stage on `node:22-alpine` pinned by digest, resolve pnpm
through corepack from `packageManager`, and run as a non-root user.

- `server/Dockerfile`: `base → deps → builder → prod-deps → tools → runner`.
  `tools` fetches `helm` and `syft` with per-architecture checksums (chart
  rendering and the platform scan need them). The runner copies `dist/`,
  `drizzle/` and `drizzle.config.ts` so the image can migrate itself
  (`MIGRATE_ON_START=true`). Listens on **3001** (`PORT` in the image);
  the docs and Compose expose it as 8080.
- `client/Dockerfile`: Next.js standalone output; `docker-entrypoint.sh`
  runs `scripts/migrate.mjs` first when `MIGRATE_ON_START=true`. Listens
  on 3000, user `nextjs`.

Both `.dockerignore` files exclude `.env*`, `.git` and `node_modules`.

## Compose

- Root `docker-compose.yml`: only PostgreSQL 18 on **5444** for local
  development, initialised by `scripts/init-db.sql` (one database,
  `server`; the client's tables live in its `auth` schema). The apps run
  with `pnpm dev` against it.
- `deploy/compose/docker-compose.yml`: the self-contained quickstart
  (Postgres + server + client, release images, public fixture secrets that
  `deploy/compose/Makefile` rotates). Its header documents every variable.
- `dev/docker-compose.yml`: the same file through Compose `include`, pinned
  to `:snapshot` by `dev/snapshot.env`.
- `dev/local-build.yml`: an override that replaces the two images with
  `build:` from `./server` and `./client` (project `stackradar-local`;
  UI 3100, API 8180, Postgres 5445 so it runs beside `pnpm dev`).
  `scripts/fresh-local.sh` runs it: `down --volumes`, build, `up -d --wait`.

## Topology and migrations

`TOPOLOGY=monolith` (the community default) runs the job worker and the
sync crons inside the API process; `split` runs `dist/src/worker.js` as its
own Deployment and the feeds as CronJobs (the chart's `topology: split`).
Replicas are safe in both: the queue claims with `SKIP LOCKED`, the syncs
take advisory locks.

Migrations run at start-up under one shared Postgres advisory lock
(`MIGRATION_LOCK_KEY`, identical in both apps and checked by
`scripts/check-cross-app-constants.mjs`), or once from an initializer Job
with `MIGRATE_EXIT_AFTER=true`. Never point a migrating process at a
database you do not own.

## Environment

The authoritative list is `AGENTS.md § Environment Variables`;
`server/.env.example` and `client/.env.example` carry local defaults.
The three a deployment must set on both apps: `DATABASE_URL` (explicit
`sslmode`), `INTERNAL_SERVICE_KEY` (the BFF → server secret) and the
edition. The server additionally needs `API_KEY_ENCRYPTION_KEY` (64 hex,
set once) and, in the community edition, the `BOOTSTRAP_CLUSTER_*` pair;
the client needs `AUTH_SECRET` and either `AUTH_URL` or `AUTH_TRUST_HOST`.

## Conventions

- Pods set CPU **requests** and memory **limits**, never CPU limits.
- Images are pinned by digest wherever a manifest is committed; a tag is
  for the human reading it.
- Health: server `GET /api/health/live` and `/ready` on 3001; client
  `GET /api/health/ready` on 3000. Readiness names the missing variable
  rather than its value.

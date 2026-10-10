---
name: deployment-k8s
description: >-
  Domain knowledge for Kubernetes deployment, ArgoCD, Kustomize overlays, Docker,
  and docker-compose. Use when working with deploy manifests, Dockerfiles,
  docker-compose, K8s resources, ArgoCD apps, or environment configuration.
---

# Deployment & Infrastructure

## Overview

| Tool | Purpose |
|------|---------|
| Kustomize | Base + overlay manifests |
| ArgoCD | GitOps deployment (auto-sync, prune, self-heal) |
| Docker | Multi-stage builds (Node 22 Alpine, pnpm) |
| docker-compose | Local PostgreSQL (port 5444) |
| DigitalOcean | Container registry |
| cert-manager | TLS certificates |

## Directory Layout

Manifests do **not** live in this repo. They are in the sibling GitOps repo
`lockdep/stackradar-gitops-development`; the workflows here check it out and write image
tags into it. Paths below are relative to that repo's root.

```
bootstrap/
└── root-app.yaml                 # the one manifest applied by hand (app-of-apps)
argocd/                           # control plane, rendered by root-app
├── kustomization.yaml            # lists every manifest below, by path
├── projects/{apps,infrastructure}.yaml
├── applications/
│   ├── infrastructure/           # argocd-ingress, cert-manager, nginx-ingress,
│   │                             #   kube-prometheus-stack, loki, alloy
│   └── apps/                     # stack-radar-{development,production},
│                                 #   landing-page, scanner
└── repo-ghcr-charts.yaml
apps/
├── stack-radar/
│   ├── base/                     # client/ (Next.js BFF) + server/ (Express API)
│   └── overlays/
│       ├── development/          # stack-radar-development namespace
│       └── production/           # stack-radar-prod namespace
├── landing-page/{base,overlays/production}/
└── scanner/values.yaml           # Helm values for the scanner chart
infrastructure/                   # Helm values: argocd, cert-manager,
                                  #   nginx-ingress, monitoring
```

`apps/stack-radar/base/server/` also holds `worker-deployment.yaml`,
`osv-sync-cronjob.yaml`, `osv-bootstrap-cronjob.yaml`, `servicemonitor.yaml`
and `prometheusrule.yaml`.

There are no `configmap.yaml` or `namespace.yaml` files in the base — config is
built by `configMapGenerator` in `apps/stack-radar/base/kustomization.yaml` (so
edits hash-rename the ConfigMap and roll the pods), and each overlay supplies
its own `patches/namespace.yaml`.

## Kustomize Pattern

- **Base**: shared resources, referenced by all overlays
- **Overlays**: env-specific patches (config, ingress, image tags)
- **Namespace**: `stack-radar-development` or `stack-radar-prod`
- **Name prefix**: `development-` or none (production)
- **Image tags**: updated in overlay `kustomization.yaml` (manually or via CI)

## ArgoCD

- Apps in `argocd/applications/apps/stack-radar-{development,production}.yaml`
- Everything is owned by the root app-of-apps (`bootstrap/root-app.yaml`), which
  renders `argocd/`. Adding a manifest there is not enough — it must also be
  listed in `argocd/kustomization.yaml`.
- Automated sync with prune and self-heal
- **Production is not live**: `syncPolicy.automated.enabled: false` is declared
  in git. Going live is deliberate — promote a real tag, create the prod
  secrets, then flip it.
- **Migration jobs** run as PreSync hooks (`argocd.argoproj.io/hook: PreSync`)

## Docker Builds

### Server (`server/Dockerfile`)
- Stages: `base` → `deps` → `builder` → `runner`
- Node 22 Alpine + pnpm
- Copies `drizzle/`, `drizzle.config.ts`, `src/db` for migration support
- Port 3001, non-root user `expressjs`

### Client (`client/Dockerfile`)
- Extra `migrator` stage for Auth.js DB migrations
- Next.js standalone output
- Port 3000, non-root user `nextjs`

## docker-compose (Local Dev)

```yaml
services:
  postgres:
    image: postgres:18-alpine
    ports: ["5444:5432"]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init-db.sql:ro
```

Creates databases: `client` (NextAuth) and `server` (app data).

## Environment Variables

### Server
| Source | Variables |
|--------|-----------|
| ConfigMap | `NODE_ENV`, `PORT` |
| Secrets | `DATABASE_URL`, `INTERNAL_SERVICE_KEY` |
| OSV sync | `OSV_POLL_INTERVAL_MS`, `OSV_BATCH_SIZE`, `OSV_MAX_PARALLEL_DOWNLOADS` |

### Client
| Source | Variables |
|--------|-----------|
| ConfigMap | `AUTH_TRUST_HOST`, `EXPRESS_API_URL`, `AUTH_URL` |
| Secrets | `AUTH_SECRET`, `DATABASE_URL`, OAuth client IDs/secrets, `INTERNAL_SERVICE_KEY` |

`INTERNAL_SERVICE_KEY` is the shared secret between client and server.

## K8s Migration Jobs

- Run as ArgoCD **PreSync hooks**
- Server: `npx drizzle-kit migrate`
- Client: `stack-radar/client-migrator` for Auth.js migrations
- Both reference `DATABASE_URL` from their respective secrets

## OSV Sync CronJob

- Runs `osv-sync --once` hourly via
  `apps/stack-radar/base/server/osv-sync-cronjob.yaml` (gitops repo)
- Uses the server image with OSV sync CLI

# Running StackRadar with Docker Compose

*Applies to: Community Edition. The cloud at app.stackradar.io runs the same
images; nothing here is needed there.*

The Compose file is the laptop try-out: the whole platform on one machine,
findings on screen in the time it takes to pull three images. It cannot scan
a cluster — the scanner is a Kubernetes agent — so it proves the platform
with an SBOM you upload yourself. To see your own cluster, use the Helm
chart, which installs the scanner alongside the server: [helm.md](helm.md).

## Start it

```sh
curl -LO https://raw.githubusercontent.com/lockdep/stackradar/main/deploy/compose/docker-compose.yml
docker compose up -d
```

Three containers come up: `postgres` (PostgreSQL 18, one database), `server`
(the API, the job worker and the OSV/EPSS/KEV sync schedule in one process —
the `monolith` topology) and `client` (the web UI). Both apps apply their
own migrations at start-up under a shared advisory lock, so there is no
migration step. The first `docker compose up` takes a minute or two: the
server waits for Postgres, migrates, seeds the default organisation and the
bootstrap cluster, and only then reports ready; the client waits for it.

Open <http://localhost:3000> and sign in with

| | |
|---|---|
| Email | `admin@stackradar.local` |
| Password | `admin` |

You are asked to change the password before anything else loads. Do it.

> [!WARNING]
> **Every secret in the file is a public fixture** — the same on every
> machine that downloads it: the database password, the service key, the
> encryption key, the session secret, the scanner key and the admin
> password. The ports bind `127.0.0.1`, so nothing off the machine can
> reach it, but anything *on* the machine can. Keep it there, or rotate the
> fixtures before the first start (below).

## What you see first

A yellow strip above every page says **Vulnerability database is being
built**. The server bootstraps its own OSV mirror in the background for the
default ecosystem list — about 1.2 GB compressed, 5–25 minutes depending on
your connection — and EPSS and KEV right after. Until it finishes every
image shows zero findings; the strip goes away on its own when the first
generation is live. Nothing else waits for it: you can upload now.

For a two-minute try-out, set `OSV_ECOSYSTEMS: Alpine` on the server in the
Compose file before the first start. That mirror is ~40 MB, bootstraps in
under two minutes, and finds everything in an Alpine-based image (the
fixture below is one). Widen the list later and the next bootstrap check
rebuilds the mirror.

## Upload an SBOM

The server runs with one cluster, `local`, and one scanner key — the
`BOOTSTRAP_CLUSTER_API_KEY` in the file. A hand upload is what the scanner
does, with `curl`. The repository carries a CycloneDX SBOM of
`nginx:1.27-alpine` under `server/tests/fixtures/`; any CycloneDX 1.5+ JSON
from `syft <image> -o cyclonedx-json` works the same way.

```sh
curl -LO https://raw.githubusercontent.com/lockdep/stackradar/main/server/tests/fixtures/nginx-1.27-alpine.deep-squashed.cdx.json

curl -sS -X POST \
  "http://localhost:8080/v1/sboms/upload/cyclonedx?imageDigest=sha256:$(shasum -a 256 nginx-1.27-alpine.deep-squashed.cdx.json | cut -c1-64)&imageRef=nginx:1.27-alpine" \
  -H "X-API-Key: stackradar-fixture-bootstrap-scanner-key" \
  -H "Content-Type: application/json" \
  --data-binary @nginx-1.27-alpine.deep-squashed.cdx.json
```

`imageDigest` is how a cluster identifies the image (the manifest digest the
scanner reads from the node); for a hand upload any `sha256:` value will do,
and the file's own hash is as good as any. A second upload of the same
digest answers `409`; add `&replace=true` to supersede it.

The response is `201` with the image id. The in-process job worker matches
the SBOM against the mirror within seconds, and the image appears on the
dashboard with its findings — once the mirror is live. An image uploaded
*before* the bootstrap finished is re-matched automatically when the first
generation is published.

Port `8080` on the host is the server's public API (`/v1/*`, what a scanner
talks to); the UI on `3000` reaches the server over the Compose network.

## Keep it: rotate the fixtures

From a checkout of the repository:

```sh
cd deploy/compose
make quickstart     # rewrite every fixture with `openssl rand`, then `docker compose up -d`
```

or `make secrets` for the rewrite alone. It replaces each fixture literal
everywhere it appears (the database password is in three places), prints
the new scanner key, refuses to run twice, and leaves the admin password as
`admin` because the first login replaces it anyway.

**Run it before the first `docker compose up`.** Postgres sets its password
when it initialises the volume, and the server's `API_KEY_ENCRYPTION_KEY`
encrypts scanner keys at rest from the first boot. On an instance that has
already started, `make reset` (which deletes the data volume) and start
over, or change the database password in Postgres yourself and edit the
two `DATABASE_URL`s by hand.

## Pin a version

```sh
STACKRADAR_TAG=1.2.0 docker compose up -d
```

The images are `ghcr.io/lockdep/stackradar-server` and
`ghcr.io/lockdep/stackradar-client`; `:latest` is the newest release,
`:<version>` is immutable, `:snapshot` is the last merge to `main`
(`dev/docker-compose.yml` in the repository runs that one). Upgrading is
`docker compose pull && docker compose up -d`: migrations run at start-up.

## Resources

| | |
|---|---|
| Server, during the OSV import | up to ~2 GB (`NODE_OPTIONS=--max-old-space-size=1536`; the file sets a 2 GB limit) |
| Server, steady state | a few hundred MB |
| Postgres, `OSV_ECOSYSTEMS=Alpine` | ~40 MB on disk |
| Postgres, default ecosystem list | not yet measured — the two mirror tables are most of it; budget low single-digit GB |
| Postgres, the whole OSV corpus (`OSV_ECOSYSTEMS=*`) | ~12 GB on disk for the two mirror tables (1.9 M advisories, 6.9 M affected-package rows, as on the cloud); the import itself is 2.5 GB of downloads |

The download is the bottleneck: the bootstrap is bound by your connection
below ~10 MB/s. `Ubuntu` and `npm` are most of the default list by bytes;
`Chainguard` and `Wolfi` are left out of it on purpose (another 1.4 GB)
and only matter if you run `cgr.dev` images — add them to `OSV_ECOSYSTEMS`
if you do.

## Sign-in providers

Local username/password is on by default. The admin creates further local
users from the Users tab, or sets `AUTH_OIDC_ISSUER`, `AUTH_OIDC_ID` and
`AUTH_OIDC_SECRET` on the client for any OpenID Connect provider (Keycloak,
Authentik, Entra ID, Okta, Zitadel; callback
`http://localhost:3000/api/auth/callback/oidc`), or the `AUTH_GITHUB_*` /
`AUTH_GOOGLE_*` pairs. A half-configured pair keeps the client from
reporting ready, on purpose. `AUTH_LOCAL_ENABLED=false` hides the form once
your identity provider works.

Locked out of the admin account:

```sh
docker compose exec client node scripts/admin-reset-password.mjs admin@stackradar.local
```

## Where to look when something is wrong

- `docker compose ps` — a container stuck `starting` is waiting on its
  readiness probe. `docker compose logs server` says why: a refused
  `DATABASE_URL` (production builds require an explicit `sslmode`; the
  file sets `prefer`), a missing variable, or a half-set bootstrap pair.
- `curl -s localhost:8080/api/health/ready` and
  `curl -s localhost:3000/api/health/ready` name the problem rather than
  the value.
- The admin area's **OSV** tab shows the mirror's state, the ecosystems it
  carries against the configured list, and recent sync runs.
- Backups: `docker compose exec postgres pg_dump -U stackradar stackradar > backup.sql`.
  The volume `stackradar_postgres-data` is everything.

## What this is not

One machine, one Postgres with no TLS on a private Compose network, one
cluster you feed by hand. It is the community edition's evaluation path,
not its production shape — that is the Helm chart, which brings the
scanner, and the cloud for several clusters in one dashboard.

## See also

[users-and-login.md](users-and-login.md) for roles and the locked-out
admin, [oidc.md](oidc.md) for the provider recipes, [own-postgres.md](own-postgres.md)
for pointing the file at a database you run, [upgrading.md](upgrading.md)
and [backup.md](backup.md).

# Context Map

Where things live in this repository and how the pieces talk to each other.
Start with [AGENTS.md](AGENTS.md) — the domain model, its invariants and the
environment each app reads — then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the full picture. How to build and test is [DEVELOPING.md](DEVELOPING.md).

## The two apps

| Context | Code | ADRs | What it is |
|---|---|---|---|
| server | `server/` | [server/docs/adr/](server/docs/adr/) | Express 5 API, the job worker, the OSV/EPSS/KEV/Artifact Hub syncs and the vulnerability matcher. Owns the database's `public` schema. |
| client | `client/` | [client/docs/adr/](client/docs/adr/) | Next.js 16 UI plus the BFF that is the only thing a browser talks to. Owns authentication (Auth.js) and the database's `auth` schema. |

The two are independent pnpm projects (no root `package.json`, no workspace);
run `pnpm` inside the app directory. A third, `e2e/`, is the Playwright
suite over both of them running as the Compose quickstart
([e2e/README.md](e2e/README.md)); it ships nothing. System-wide decisions are in
[docs/adr/](docs/adr/); the per-app directories above hold decisions that
only concern that app.

## Relationships

- **Browser → client (BFF) → server.** The client authenticates the user
  (Auth.js session) and proxies `/api/*` to Express with an
  `INTERNAL_SERVICE_KEY` header plus identity headers it builds from scratch
  ([ADR 0002](docs/adr/0002-bff-proxy-with-internal-service-key.md)). The
  server re-verifies org membership on every request; the BFF is the only
  caller allowed to assert a user identity.
- **Scanner → server.** The in-cluster agent
  ([lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner))
  bypasses the BFF and calls the server's `/v1/*` endpoints directly with a
  cluster-scoped API key: heartbeat, the full-set inventory report and SBOM
  check/upload. This is the only SBOM ingestion path. The wire format is
  [docs/contracts/inventory-v3.md](docs/contracts/inventory-v3.md); both
  repositories encode it, so change the contract first.
- **client ↔ server (shared database).** One PostgreSQL database: the
  client's Auth.js tables live in the `auth` schema, the server's data in
  `public`. No foreign keys cross the boundary — the server mirrors users by
  bare id. This superseded
  [ADR 0003](docs/adr/0003-separate-databases-per-context.md); see
  [AGENTS.md § Database Setup](AGENTS.md#database-setup).
- **Internal match endpoint.** `POST /internal/match` exposes the server's
  matcher as a stateless function for a separate service of the maintainers
  (a public chart index). It is keyed by its own secret, mounted only when
  `MATCH_SERVICE_KEY` is set, and documented as a contract in
  [docs/contracts/match-endpoint.md](docs/contracts/match-endpoint.md).

## Other documents

- [docs/authorization-matrix.md](docs/authorization-matrix.md) — who may do
  what, per edition, with the file that decides it.
- [docs/self-hosting/](docs/self-hosting/README.md) — running the community
  edition with Compose or Helm.

# Context Map

This is a multi-context repository. Each package has its own domain language and architectural decisions.

| Context | CONTEXT.md | ADRs | Description |
|---|---|---|---|
| server | [server/CONTEXT.md](server/CONTEXT.md) | [server/docs/adr/](server/docs/adr/) | Express API — jobs, OSV sync, vulnerability matching |
| client | [client/CONTEXT.md](client/CONTEXT.md) | [client/docs/adr/](client/docs/adr/) | Next.js frontend + BFF |

## Relationships

- **client → server**: The client's BFF proxies authenticated requests to the Express server using the `INTERNAL_SERVICE_KEY` header.
- **scanner agent → server**: The StackRadar scanner agent runs inside a customer's Kubernetes cluster, scans workloads, and uploads SBOMs directly to the server's `/v1/*` endpoints using a cluster-scoped API key — bypassing the BFF. This is the only SBOM ingestion path.
- **client ↔ server (shared identity)**: Both reference the same `User`/`Organization` concepts and share one PostgreSQL database — the client's Auth.js tables live in its `auth` schema, the server's application data in `public` (open-source plan step 05, which superseded [ADR 0003](docs/adr/0003-separate-databases-per-context.md)).
- **chart index → server**: The public chart index ([lockdep/stackradar-charts-index](https://github.com/lockdep/stackradar-charts-index)) calls `POST /internal/match` and nothing else ([docs/contracts/match-endpoint.md](docs/contracts/match-endpoint.md)).
- **marketing site**: [lockdep/stackradar-landing](https://github.com/lockdep/stackradar-landing) links visitors to the client's sign-in flow and vendors a few of its presentational components. It shares no runtime state, session or database with either context.

System-wide decisions live in [docs/adr/](docs/adr/).

# Database-backed sessions, with the scanner agent bypassing the BFF

Authentication uses Auth.js v5 with database-backed sessions (not JWTs) stored in the client database, and runs at the Next.js layer. Interactive traffic flows browser → BFF → Express. The StackRadar scanner agent is the deliberate exception: running inside a customer's Kubernetes cluster, it has no interactive session, so it calls Express directly on `/v1/*` using a cluster-scoped API key rather than going through the BFF.

## Consequences

- Sessions can be revoked server-side (a property JWTs don't give us), at the cost of a DB lookup per request.
- There are two distinct trust paths into Express — the BFF's `INTERNAL_SERVICE_KEY` (interactive users) and the scanner agent's cluster-scoped API key (machine-to-machine) — and both must be accounted for in any auth change. SBOM upload specifically rejects non-cluster-scoped keys.
# Mirror the OSV database locally instead of querying OSV.dev live

Status: Accepted

We maintain a full local mirror of the OSV.dev vulnerability database (~300k+ records) in the `osv_*` tables, synced via a bootstrap (ZIP archives) and an incremental poll, rather than querying the OSV.dev API at match time. Matching SBOM components against ~300k vulnerabilities per scan is impractical over a remote API (latency, rate limits), and a local denormalized affected-package index makes matching fast and reliable.

## Consequences

- We own sync correctness: watermarks, failure tracking, and re-bootstrap are first-class concerns (`osv-sync/`).
- Match results are only as fresh as the last successful sync.

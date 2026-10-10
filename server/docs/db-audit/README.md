# Database Audit — StackRadar

Audit of `server/src/db/schema/**` and `server/src/repositories/**` with the goal of answering:

1. Do the schemas match the query patterns?
2. Are the right indexes in place?
3. Is the design enterprise-grade and scalable?

## Verdict

Above-average for a mid-stage codebase. The schema shows clear attention to hot paths:
FK cascade performance (`delete-helpers.ts`), worker queue correctness
(`FOR UPDATE SKIP LOCKED` in `claimNextJobs`), composite indexes annotated with the
exact query they serve, SBOM dedup via `uniqueIndex(project_id, sbom_sha256)`, and a
properly denormalized `osv_affected_packages` lookup table.

It is **not yet enterprise-grade**. The gaps cluster around three themes:

- **Multi-tenancy isolation** — missing `org_id` indexes and at least one cross-org
  data leak in `findAllWithStats`.
- **Hot-path write churn** — `jobs` and `sboms` are missing partial/ordered indexes
  that would otherwise avoid sorts and full-index scans.
- **Duplicated vulnerability stacks** — `vulnerabilities` + `vulnerability_affected_packages`
  run in parallel with `osv_vulns` + `osv_affected_packages`. Drift risk is real.

## Structure

Findings are grouped by priority so they can be worked down in order:

| Doc | Scope | When to do it |
|-----|-------|---------------|
| [`P0-correctness.md`](./P0-correctness.md) | Correctness & tenant-isolation bugs | Before next release |
| [`P1-missing-indexes.md`](./P1-missing-indexes.md) | Missing indexes on real query paths | Next sprint |
| [`P2-schema-design.md`](./P2-schema-design.md) | Architectural design issues | Next 1–2 quarters |
| [`P3-polish.md`](./P3-polish.md) | Minor polish / cleanup | Whenever |

Each doc lists findings with:
- **Evidence** — file + line that demonstrates the issue
- **Root cause** — what the current schema/query does and why it fails
- **Fix** — concrete SQL or Drizzle migration
- **Impact** — what this costs you at scale

## Suggested order of execution

1. `P0-correctness.md` item 1 (`findAllWithStats` cross-org leak) — data-exposure bug.
2. `P0-correctness.md` items 2–4 (unique constraints for race-free writes).
3. `P1-missing-indexes.md` all — one migration, many indexes.
4. `P2-schema-design.md` item 1 (dual vuln stack) — biggest tech-debt.
5. `P2-schema-design.md` item 2 (JSONB raw payloads → object storage).
6. `P2-schema-design.md` items 3–8 as capacity allows.
7. `P3-polish.md` opportunistically.

## Metrics to track after fixes

Before applying migrations, capture a baseline for:

- `GET /api/projects` p95 latency (currently unbounded — scans all orgs).
- `POST /api/sboms/upload/cyclonedx` end-to-end time for a 5k-component SBOM.
- Job worker claim latency (`jobRepository.claimNextJobs`) under queue depth ≥ 1000.
- `vulnerabilityRepository.findByProjectId` for a 10k-component project.
- Database size (`pg_database_size`) and per-table size (`pg_total_relation_size`).

After P0 + P1 you should see most of these drop by at least an order of magnitude
on any non-trivial dataset.

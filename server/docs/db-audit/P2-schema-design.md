# P2 — Architectural Schema-Design Issues

These are not bugs and not missing indexes — they are **shape-of-the-schema**
decisions that will block the product from passing enterprise due diligence (SOC2,
ISO 27001, large-customer infra review) and will become painful to change once
data volume grows.

None of these are urgent this week. All of them will be urgent within 2–4 quarters.

---

## P2-1. Dual vulnerability stack

**Effort:** ~1 week. **Blast radius:** significant (matcher, UI, sync service).

### Problem

You have two parallel vulnerability stores holding overlapping data:

| App-facing | Mirror |
|------------|--------|
| `vulnerabilities` | `osv_vulns` |
| `vulnerability_affected_packages` | `osv_affected_packages` |
| `component_vulnerabilities` | (matcher joins both) |
| `vulnerability_sync_status` | `osv_sync_state` + `osv_sync_runs` + `osv_sync_failures` |

Both tables store `cvss_score`, `severity_level`/`severity_label`, CVSS vector,
raw JSON, range arrays, versions arrays, fixed-version derivations. The matcher
reads from `osv_affected_packages` but the API reads from `vulnerabilities`.
That implies a copy step — which is exactly the drift risk.

Evidence:

- `server/src/db/schema/vulnerabilities.ts` — full stack.
- `server/src/db/schema/osv-mirror.ts` — parallel stack.
- `server/src/services/vulnerability-sync.service.ts` writes to both.

### Options

**Option A — Single source of truth = `osv_vulns`** (recommended).
- Drop `vulnerabilities` and `vulnerability_affected_packages`.
- Keep `component_vulnerabilities` but point `vulnerability_id` at `osv_vulns.id`
  (change column type from `uuid` to `text` and the FK target).
- Read `severity_level` / `cvss_score` / `details` directly from `osv_vulns`
  at query time.
- Move the `source = 'osv' | 'nvd' | 'github'` concept into `osv_vulns.source`
  or derive from `id` prefix (`GHSA-*` → github, `CVE-*` → nvd, etc).

Pros: one table, no drift. Cons: joins across `text`-keyed table; slightly
higher read cost.

**Option B — Materialized view**.
- Keep both tables shape-wise, but make `vulnerabilities` a `MATERIALIZED VIEW`
  over `osv_vulns`. Refresh after every sync cycle.

Pros: fewer code changes. Cons: refresh cost, the view still ages between
refreshes.

**Option C — Status quo + sync job**.
- Keep both, write a background job that reconciles them.

Not recommended. This is what you have now, and it's the source of the drift
risk.

### Follow-ups once collapsed

- P1-6 and P1-7 become moot (their indexes already exist on the OSV tables).
- `findBySbomId` / `findByProjectId` in `vulnerability.repository.ts` become
  simpler — no more dedup-map-by-range post-processing, because the matcher
  already produced confirmed matches.

---

## P2-2. JSONB "raw" columns balloon the database

**Effort:** ~1 week. **Blast radius:** medium — touches upload + read paths.

### Problem

Three tables store full raw payloads inline as JSONB:

- `sboms.raw_json` — a CycloneDX document, typically 5–50 MB for a container image.
- `vulnerabilities.raw_data` — full OSV record.
- `osv_vulns.raw` — same thing, again.

At 10k SBOMs × ~10 MB = 100 GB of TOAST-compressed JSONB inside Postgres. This:

- Bloats backups (dumps, WAL, replicas).
- Slows `VACUUM` / `ANALYZE`.
- Wastes cache memory for a column you almost never read (only the original
  download endpoint needs it).
- Forces expensive TOAST deTOASTs on accidental `SELECT *`.

Enterprise customers on self-hosted deployments will feel this first.

### Fix

Object storage (S3, GCS, Azure Blob) keyed by content hash.

```ts
// sboms table becomes:
sbomSha256: varchar(64).notNull(),  // already exists
rawStorageKey: varchar(512),         // e.g. "sboms/ab/cd/abcdef...json.gz"
rawSizeBytes: integer(),
rawContentEncoding: varchar(20),     // 'gzip' | 'br' | null
// drop rawJson
```

- Upload path writes compressed SBOM to object storage with `Content-MD5`
  verification, then inserts the row with the storage key.
- Download endpoint (the one or two that actually need the raw SBOM) streams
  from object storage with a signed URL.
- Deduplication: since `sbomSha256` already exists in the unique constraint,
  multiple projects uploading the same SBOM already share a hash — they could
  share a storage object too. A separate `sbom_blobs(sha256 PRIMARY KEY, key,
  size)` table makes this clean.

Apply the same pattern to `vulnerabilities.raw_data` / `osv_vulns.raw` —
serialize the `osv_vulns` dump to object storage and keep only the normalized
columns in Postgres. The matcher never reads `raw`.

### Migration plan

1. Add storage-key columns as nullable.
2. Backfill job: read `raw_json`, write to S3, set the key column.
3. Read path: fall back to inline `raw_json` when the storage key is null.
4. After backfill is complete, drop the column.

---

## P2-3. No DB-level enum enforcement

**Effort:** half a day. **Blast radius:** migration + test updates.

### Problem

Every state-machine-ish column is `varchar` with a TS branded type:

- `jobs.status` (pending/scheduled/processing/completed/failed/cancelled)
- `jobs.type`, `jobs.triggered_by`
- `org_members.role`
- `projects.type` (project/group)
- `components.scope` (required/optional/excluded)
- `component_vulnerabilities.matched_by`, `match_confidence`
- `vulnerabilities.severity_level`
- `api_keys.scopes` (comma-separated!)
- `organizations.plan`, `color`

TypeScript cannot protect you from a stray raw SQL write or a buggy migration
inserting `'Pending'` instead of `'pending'`. At that point every enum-based
filter silently starts missing rows.

### Fix

Two options:

**Option A — `pgEnum`**:

```ts
// drizzle-orm supports pgEnum natively
export const jobStatus = pgEnum("job_status", [
    "pending", "scheduled", "processing", "completed", "failed", "cancelled",
]);
```

Pros: strongest guarantee. Cons: altering enums requires
`ALTER TYPE ... ADD VALUE` (OK) and removal is awkward (create new enum, swap,
drop old).

**Option B — CHECK constraints**:

```sql
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('pending','scheduled','processing','completed','failed','cancelled'));
```

Easier to evolve, no type-swap dance, but less discoverable than an enum type.

Pick one consistently. For `api_keys.scopes`, the **comma-separated
string** is its own problem — split to `api_key_scopes` join table or at least
a `text[]` column.

---

## P2-4. No row-level security (RLS)

**Effort:** ~3 days including test updates. **Blast radius:** transaction-level
session var discipline.

### Problem

Tenant isolation is 100% enforced in application code. As P0-1 demonstrates,
that's one missing `.where(eq(orgId, ...))` away from a data-exposure incident.
Every serious multi-tenant SaaS eventually adopts RLS as a second line of defence.

### Fix (sketch)

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant ON projects
    USING (org_id::text = current_setting('app.current_org_id', true));

-- Repeat for every tenant-scoped table: sboms, components, jobs, api_keys,
-- clusters, org_invites, org_members (trickier because role affects visibility).
```

At the start of every request set `SET LOCAL app.current_org_id = '...'` inside
the transaction (or via a pg connection wrapper). Postgres refuses any query
that would cross tenants regardless of how broken the application query is.

Note: drizzle + postgres-js need a wrapper for `SET LOCAL` per-request; this is
the main integration cost. There are write-ups for this exact combination.

---

## P2-5. Half-finished soft-delete

**Effort:** 2–3 days. **Blast radius:** every `findBy*` query on soft-deletable
tables.

### Problem

- `organizations.deleted_at` exists and is filtered in the repo.
- Nothing else is soft-deletable. Projects, SBOMs, users, jobs are hard-deleted.
- `PROJECT_SOFT_DELETE.md` describes an unimplemented design.

This is inconsistent and breaks common enterprise requirements: "accidentally
deleted a project, we need it back for audit".

### Fix

Decide. Either:

- **Commit to soft-delete for tenant-owned entities** (projects, sboms, api_keys,
  clusters). Add `deleted_at` column, update every repo, update FK cascade
  strategy (soft-deleting a project should soft-delete its SBOMs), and finish
  `PROJECT_SOFT_DELETE.md`.
- **Remove it entirely** — drop `organizations.deleted_at`, delete
  `PROJECT_SOFT_DELETE.md`, document the hard-delete choice.

Half-done is worst of both worlds.

---

## P2-6. Unbounded result sets on read endpoints

**Effort:** iterative, touches ~10 endpoints. **Blast radius:** contract change
on API responses.

### Problem

These repo methods return the full result set with no `LIMIT`/`OFFSET`/keyset:

- `vulnerabilityRepository.findByProjectId`
- `vulnerabilityRepository.findBySbomId`
- `componentRepository.findByProjectIdWithDetails`
- `componentRepository.findBySbomIdWithDetails`
- `sbomRepository.findByProjectIdWithComponentCount`

A project with 10k components × 5 vulns each = 50k rows serialized over HTTP.
At enterprise scale this is both slow and a memory hazard for the Node process.

### Fix

- Add keyset pagination: `(cvss_score DESC, vuln_id)` for vuln lists,
  `(name ASC, id)` for components.
- Keep an unpaginated variant for CSV/JSON exports, but rate-limit and stream it.
- Client contract: return `{ items, nextCursor }`.

Start with the vuln endpoints (biggest rows). Components come next.

---

## P2-7. FK `ON DELETE` inconsistency and orphans

**Effort:** one migration. **Blast radius:** low.

### Problem

`api_keys.cluster_id` has `ON DELETE SET NULL`. The hot-path
`validateApiKeyByHash` does **not** filter on cluster membership — it just
checks `key_hash` and `is_active`. So deleting a cluster leaves its API keys
active, valid, unscoped, and orphaned.

### Fix

Either:

- **Cascade**: `ON DELETE CASCADE` when deleting a cluster deletes its API keys.
- **Refuse**: `ON DELETE RESTRICT`, force the app to revoke keys first.
- Or **keep SET NULL but revoke**: when a cluster is deleted, transition its
  keys to `is_active=false` inside the same transaction. Explicit is better
  than implicit.

Recommend the third option; the repo method `clusterRepository.revokeApiKey`
already exists, just call it from the delete path.

---

## P2-8. No partitioning plan for unbounded tables

**Effort:** ~1 week per partitioned table. **Blast radius:** medium — requires
table rebuild.

### Problem

These tables grow without bound:

- `osv_vulns` — hundreds of thousands of rows today, millions at full distro
  coverage.
- `osv_affected_packages` — denormalized, grows faster than `osv_vulns`.
- `components` — every SBOM upload adds thousands of rows; no retention.
- `component_vulnerabilities` — cross product of the above.
- `jobs` — `cleanupOld` helps but isn't partition-efficient.

Postgres handles this fine up to low tens of millions of rows per table. Past
that you start seeing vacuum pain, index bloat, and slow backups.

### Fix (when you hit the scale)

- `osv_vulns` / `osv_affected_packages` — partition by `ecosystem_dir` (LIST
  partitioning). Each ecosystem is naturally bounded.
- `jobs` — partition by `created_at` month (RANGE). Dropping old months becomes
  a metadata operation; `cleanupOld` goes from hours to milliseconds.
- `components` / `component_vulnerabilities` — only if retention policy demands
  it; otherwise the FK cascade story already limits growth to "live SBOMs".

Not urgent. Flag for revisit at ~10M rows in any single table.

---

## P2-9. Component search has no full-text or trigram index

**Effort:** half a day. **Blast radius:** none.

### Problem

Any "search components by name" or "find CVE by CPE wildcard" UI feature will
end up doing `LIKE '%foo%'` against `components.name` / `components.purl` /
`components.cpe`. Plain btree indexes can't satisfy prefix-wildcard filters.

### Fix (if/when you ship search UI)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX components_name_trgm_idx ON components USING GIN (name gin_trgm_ops);
CREATE INDEX components_purl_trgm_idx ON components USING GIN (purl gin_trgm_ops);
```

Don't add these until the UI needs them — they cost on every insert.

---

## P2-10. No audit log

**Effort:** ~3 days. **Blast radius:** low.

### Problem

For enterprise customers, "who added this user to my org?", "when was this
project deleted?", "who rotated the cluster key?" are must-answer questions.
Currently the only audit trail is application-level logs in whatever logging
system is configured, which is insufficient for SOC2 evidence.

### Fix

Add an `audit_events` table:

```ts
export const auditEvents = pgTable("audit_events", {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorApiKeyId: uuid("actor_api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    action: varchar("action", { length: 100 }).notNull(), // 'project.create', 'member.invite', ...
    targetType: varchar("target_type", { length: 50 }),    // 'project' | 'sbom' | ...
    targetId: varchar("target_id", { length: 100 }),
    metadata: jsonb("metadata"),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("audit_events_org_created_idx").on(table.orgId, table.createdAt),
    index("audit_events_target_idx").on(table.targetType, table.targetId),
]);
```

Write to it from every mutating controller. Later, partition by `created_at`
month for retention.

---

## Checklist

- [ ] P2-1  Collapse vulnerability stack onto `osv_vulns`
- [ ] P2-2  Move raw JSONB payloads to object storage
- [ ] P2-3  Replace `varchar` enums with `pgEnum` or CHECK constraints
- [ ] P2-4  Row-level security policies
- [ ] P2-5  Finish or remove soft-delete
- [ ] P2-6  Pagination on unbounded list endpoints
- [ ] P2-7  `ON DELETE` consistency (especially `api_keys.cluster_id`)
- [ ] P2-8  Partitioning plan for `osv_vulns`, `osv_affected_packages`, `jobs`
- [ ] P2-9  Trigram indexes for search (when search UI ships)
- [ ] P2-10 Audit log table

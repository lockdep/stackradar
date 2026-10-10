# P0 — Correctness & Tenant-Isolation

These findings are **bugs**, not optimizations. Each one is either a data-exposure
risk or a race condition that can corrupt state under normal concurrent load
(e.g. two CI uploads racing).

Fix these before the next release.

---

## P0-1. `findAllWithStats` leaks data across organizations

**Severity:** Critical — cross-tenant data exposure.

### Evidence

`server/src/repositories/project.repository.ts`, invoked from
`server/src/controllers/project.controller.ts:66` by `GET /api/projects`:

```ts
async findAllWithStats(): Promise<ProjectWithStats[]> {
    const projects = await db.select().from(schema.projects);
    if (projects.length === 0) return [];

    const latestSboms = await db
        .select({ projectId: ..., createdAt: ..., sourceVersion: ... })
        .from(schema.sboms)
        .where(sql`(${schema.sboms.projectId}, ${schema.sboms.createdAt}) IN (
            SELECT project_id, MAX(created_at)
            FROM sboms
            GROUP BY project_id
        )`);
    // ... vulnCounts and componentCounts are also global aggregates
}
```

There is no `orgId` filter in this function or its callers.

### Root cause

The controller calls the repository with no tenant scope. The repository method
`findAll()` and `findAllWithStats()` do not accept an `orgId`. The `/api/projects`
route is gated by `requireAuth` but that only proves identity, not authorization.

### Fix

1. Change the repo signature to require `orgId`:
   ```ts
   async findAllWithStats(orgId: string): Promise<ProjectWithStats[]>
   ```
2. Filter `projects` and every downstream aggregate by `orgId`.
3. Collapse the three follow-up queries (latest SBOM, vuln counts, component counts)
   into a single CTE keyed on `(orgId, projectId)` so you don't round-trip four times.
4. Have the controller pull `orgId` from `req.auth.orgId` (already available — see
   `createOrganization` / `requireOrg` middleware).
5. Audit every other `findAll*` repo method for the same bug:
   - `sbomRepository.findAll()` — global SBOM scan, callable from `GET /api/sboms`.
   - `vulnerabilityRepository.getVulnerabilityCount*` — global counts, OK for admin
     endpoints only, should be explicitly labelled.
   - `jobRepository.findAllProcessing()` — intentional global (worker recovery),
     leave as-is but confirm it's not exposed on any HTTP route.

### Impact

As written today, any authenticated user of org A can see project names, SBOM
version strings, and vulnerability counts of org B. This alone makes the product
non-GDPR-compliant and non-SOC2-ready.

---

## P0-2. No uniqueness for `projects (org_id, parent_id, name)`

**Severity:** High — race condition on concurrent project create.

### Evidence

`server/src/repositories/project.repository.ts`:

```ts
async findByNameAndOrgAndParent(name, orgId, parentId) { ... }
```

Callers do a "does it exist?" check and then `create()` — two separate round-trips.
Under concurrent CI uploads from the same repo (very normal for this product) two
workers can both see `undefined` and then both insert.

`server/src/db/schema/projects.ts` has **no unique constraint** on any combination.

### Root cause

Uniqueness is enforced at the application layer, not in the DB. Classic TOCTOU.

### Fix

Two complications that need handling:

- `parent_id` can be `NULL` (top-level projects).
- Postgres treats `NULL` as distinct in unique constraints, so
  `UNIQUE (org_id, parent_id, name)` does **not** prevent two top-level projects
  with the same name.

Use a `COALESCE` trick, or two partial indexes:

```sql
-- Top-level (no parent)
CREATE UNIQUE INDEX projects_org_name_top_unique
  ON projects (org_id, name)
  WHERE parent_id IS NULL;

-- Nested
CREATE UNIQUE INDEX projects_org_parent_name_unique
  ON projects (org_id, parent_id, name)
  WHERE parent_id IS NOT NULL;
```

Drizzle equivalent:

```ts
}, (table) => [
    index("projects_parent_id_idx").on(table.parentId),
    uniqueIndex("projects_org_name_top_unique")
        .on(table.orgId, table.name)
        .where(sql`${table.parentId} IS NULL`),
    uniqueIndex("projects_org_parent_name_unique")
        .on(table.orgId, table.parentId, table.name)
        .where(sql`${table.parentId} IS NOT NULL`),
]);
```

Then change controllers to catch `unique_violation` (Postgres error code `23505`)
and return a `409 Conflict`, dropping the pre-check.

### Impact

Without this you will periodically get duplicate `(org, parent, name)` rows which
confuse the cluster scanner (`sbomRepository.existsByDigestAndProject` resolves
projects by name) and produce ghost projects in the UI.

---

## P0-3. No enforcement of "only one current SBOM per project"

**Severity:** High — logic bug under concurrent uploads.

### Evidence

`server/src/db/schema/sboms.ts`:

```ts
// Whether this is the current/active SBOM for the project (only one per project)
isCurrent: boolean("is_current").notNull().default(false),
```

The comment states the invariant but nothing enforces it. `sbomRepository.unsetCurrentForProject`
+ insert-new-current is not wrapped in a single transaction at every call site, and
even when it is, two transactions running concurrently can both pass their `SELECT`
phase before either `UPDATE`s.

### Root cause

Missing partial unique index.

### Fix

```sql
CREATE UNIQUE INDEX sboms_one_current_per_project
  ON sboms (project_id)
  WHERE is_current = true;
```

Drizzle:

```ts
uniqueIndex("sboms_one_current_per_project")
    .on(table.projectId)
    .where(sql`${table.isCurrent} = true`),
```

Then in the upload path, do:

1. `INSERT ... is_current=true`.
2. If it fails with `23505`, run `unsetCurrentForProject` in the same transaction
   and retry the insert once.

Or flip the pattern: always insert with `is_current=false`, then in a transaction
`UPDATE` old current → false and new → true.

### Impact

Today, if two uploads race, you can end up with two `is_current=true` rows for the
same project. Every downstream query (`getCurrentSbomForProject`, `findByProjectIdCurrent`,
project stats, vuln aggregation) will then silently pick whichever row the planner
returns first — non-deterministic and hard to reproduce.

---

## P0-4. `api_keys (key_hash)` is not unique and the hot-path index is suboptimal

**Severity:** Medium — correctness + auth latency.

### Evidence

`server/src/db/schema/api-keys.ts`:

```ts
keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),
keyHash:   varchar("key_hash",   { length: 255 }).notNull(),
...
// Hot path: validateApiKeyByHash runs on every authenticated request
index("api_keys_key_hash_prefix_idx").on(table.keyHash, table.keyPrefix),
```

`server/src/repositories/api-key.repository.ts:validateApiKeyByHash` filters on
`keyHash`, `keyPrefix`, and `isActive = true`. `keyPrefix` is derivable from the
plaintext key and adds no security — it is purely a display convenience.

### Root cause

- `keyHash` is a SHA-256 hash and is cryptographically unique, but no DB constraint
  enforces it. An accidental duplicate (migration bug, replication race) would
  cause `validateApiKeyByHash` to silently return the first match.
- The composite `(key_hash, key_prefix)` index is wider than needed, and does not
  leverage the most common filter (`is_active = true`).

### Fix

```sql
CREATE UNIQUE INDEX api_keys_key_hash_active_unique
  ON api_keys (key_hash)
  WHERE is_active = true;

-- Optional: keep a secondary for revoked-key lookups by admins
CREATE INDEX api_keys_key_hash_any_idx ON api_keys (key_hash);

DROP INDEX api_keys_key_hash_prefix_idx;
```

Drizzle:

```ts
uniqueIndex("api_keys_key_hash_active_unique")
    .on(table.keyHash)
    .where(sql`${table.isActive} = true`),
```

Drop `keyPrefix` from the auth query entirely:

```ts
// before
.where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.keyPrefix, keyPrefix), eq(apiKeys.isActive, true)))
// after
.where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
```

Keep `keyPrefix` as a display column (list screens, revocation UI), just stop
using it as a filter.

### Impact

Every authenticated request does one of these lookups. The partial unique index
on `key_hash` cuts the index size roughly 1:1 with revoked-to-active ratio
(typically > 2:1 in long-lived orgs) and makes the lookup provably unique.

---

## Checklist

- [x] P0-1 — `findAllWithStats` org filter (and audit of every `findAll*`)
- [x] P0-2 — `projects` unique on `(org_id, [parent_id], name)`
- [x] P0-3 — `sboms` partial unique on `(project_id) WHERE is_current`
- [x] P0-4 — `api_keys` partial unique on `(key_hash) WHERE is_active`

All four shipped in a single Drizzle migration
(`server/drizzle/0016_demonic_betty_brant.sql`). P0-1 was a code change (plus
gating `/api/projects` with `requireAuth` + `requireOrg`, which it previously
lacked entirely — noted during the fix). The others are schema migrations
plus controller-side handling of `23505` via `server/src/lib/pg-errors.ts`.

### What shipped

| Finding | Schema change | Code change |
|---|---|---|
| P0-1 | — | `findAllWithStats(orgId)`, `sbomRepository.findAllByOrg`, route auth middleware, audit comments on `getVulnerabilityCount*` / `findAllProcessing` |
| P0-2 | `projects_org_name_top_unique`, `projects_org_parent_name_unique` | `projectRepository.findOrCreate{TopLevel,Nested}`; controller maps `23505` → 409 |
| P0-3 | `sboms_one_current_per_project` | `createFromCycloneDx` retries once on unique violation for this index |
| P0-4 | `api_keys_key_hash_active_unique`, `api_keys_key_hash_any_idx` (dropped `api_keys_key_hash_prefix_idx`) | `validateApiKey` no longer filters by `keyPrefix` |

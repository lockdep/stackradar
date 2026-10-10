# P3 — Polish and Cleanup

Low-risk, low-priority items. Do these opportunistically, or batch them into a
"schema cleanup" week. None of them will move the needle on scalability, but each
removes a small foot-gun.

---

## P3-1. `users.email` case handling

### Problem

`users.email` has a plain `unique()` constraint. Emails are case-insensitive
per RFC 5321, but Postgres unique is case-sensitive. `ensureUserExists` stores
whatever the auth provider returns (usually lowercased by Auth.js, but not
guaranteed), while `isMemberByEmail` and `getUserByEmail` rely on lowercased
input.

One capitalization mismatch and a user can accidentally get two accounts.

### Fix

```sql
DROP INDEX users_email_key;
CREATE UNIQUE INDEX users_email_lower_unique ON users (LOWER(email));
```

And normalize at write time in `ensureUserExists`:

```ts
.values({
    id: userData.id,
    email: userData.email.toLowerCase(),
    name: userData.name,
})
```

Apply the same to `getUserByEmail` (already passes lowercased email from some
call sites, not from others).

---

## P3-2. `organizations.slug` is case-sensitive

### Problem

`Acme` and `acme` can coexist because the unique constraint is case-sensitive.
Slugs are user-visible in URLs; two different orgs with slugs that differ only
by case is hostile UX.

### Fix

`generateUniqueSlug` already lowercases. Enforce at DB level:

```sql
-- Combines with the P1-9 soft-delete partial:
DROP INDEX organizations_slug_active_unique;
CREATE UNIQUE INDEX organizations_slug_active_unique
  ON organizations (LOWER(slug))
  WHERE deleted_at IS NULL;
```

---

## P3-3. `varchar` lengths too short in a few places

### Problem

- `components.purl varchar(1024)` — most PURLs fit, but
  `pkg:nuget/...` and long Maven GAV strings can exceed this.
- `components.cpe varchar(512)` — CPE 2.3 URIs with 13 fields plus edition
  extensions can exceed.
- `jobs.progress_message varchar(500)` — truncated stack traces.
- `jobs.error_message` is `text` (good), but `error_code varchar(50)` will
  truncate Node error classes like `ECONNREFUSED_ENOTFOUND_RESOLVE` variants.

### Fix

Prefer `text` over `varchar(n)` when the upper bound is not a product
constraint. Postgres stores them identically.

```sql
ALTER TABLE components             ALTER COLUMN purl             TYPE text;
ALTER TABLE components             ALTER COLUMN cpe              TYPE text;
ALTER TABLE jobs                   ALTER COLUMN progress_message TYPE text;
ALTER TABLE jobs                   ALTER COLUMN error_code       TYPE text;
```

Update Drizzle schema types to match.

---

## P3-4. Non-SPDX licenses can duplicate

### Problem

`licenses.spdxId` is unique but nullable. `name` and `expression` are not
constrained at all. `componentRepository.batchFindOrCreateLicenses` dedupes
in-memory **within a batch** but two separate uploads can insert duplicate
"Custom license text" rows.

### Fix

Either:

- Add a unique constraint on `(COALESCE(spdx_id, ''), COALESCE(expression, ''), COALESCE(name, ''))`.
- Or a deterministic content-hash column: `licenses.content_sha256` unique.
- Or accept duplicates and dedupe on read (cheapest; defensible).

Pick based on how often non-SPDX licenses appear in your SBOMs. If rare, do
nothing.

---

## P3-5. Naming / declaration inconsistencies

### Problem

- `component_hashes` uses `unique("component_hash_alg_unique", ...)` (constraint-style).
- `clusters` uses `uniqueIndex("clusters_name_org_unique", ...)` (index-style).
- Both work, but it's nicer if the schema picks one idiom.

- Some FKs are declared inline via `.references(() => ...)` (preferred for
  readability).
- `vulnerabilities.ts` uses explicit `foreignKey({...})` calls — necessary
  because the FK references a sibling table in the same file, but could be
  reformatted.

### Fix

Housekeeping. Pick one idiom, document it in
`server/src/db/schema/README.md`, and normalize over time.

---

## P3-6. `component_dependencies` has no `created_at`

### Problem

If a dep graph is rebuilt (e.g. after re-running syft with a different
flag set) you can't tell when edges last changed. Not critical today but handy
for debugging edge-case matcher bugs.

### Fix

```ts
createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
```

Low priority — only add if you hit a real debugging need.

---

## P3-7. `osv_vulns_modified_desc_idx` is not actually DESC

### Problem

The index is declared as `index("osv_vulns_modified_desc_idx").on(modified)`,
i.e. ascending. Postgres can scan a btree backwards at equal cost, so this
isn't a performance issue — but the name misleads readers.

### Fix

Either rename the index or declare it DESC explicitly:

```ts
index("osv_vulns_modified_desc_idx").on(sql`${table.modified} DESC`),
```

---

## P3-8. `osv_sync_failures` composite index

### Problem

`osv_sync_failures_run_id_idx` and `osv_sync_failures_occurred_at_idx` are
separate. The natural query — "show all failures for run X ordered by time" —
needs both. Postgres will either bitmap-or them or pick one and sort.

### Fix

```sql
CREATE INDEX osv_sync_failures_run_occurred_idx
  ON osv_sync_failures (sync_run_id, occurred_at);

DROP INDEX osv_sync_failures_run_id_idx; -- redundant with the composite's leading column
```

Keep `osv_sync_failures_occurred_at_idx` for the "all recent failures across
runs" query.

---

## P3-9. `jobs.max_retries` default is baked into the schema

### Problem

`jobs.max_retries` defaults to 3 via the column default. Different job types
may want different limits (e.g. OSV sync can tolerate more retries than a
user-triggered scan). Right now the default silently applies when callers
forget to pass a value.

### Fix

Two options:

- Keep the column default and document per-job-type overrides in the job
  creation service.
- Drop the default and make callers pass it explicitly — forces the decision
  to be conscious.

Minor; status-quo is acceptable.

---

## P3-10. `api_keys.scopes` is a comma-separated string

### Problem

`scopes: text("scopes").notNull().default("sbom:write")` stores
`"sbom:write,sbom:read"`. Querying "all keys that can write SBOMs" requires
`LIKE '%sbom:write%'`, which is unindexable and fragile (what if a future scope
is named `sbom:write-limited`?).

### Fix

Either:

- `text[]` column:
  ```ts
  scopes: text("scopes").array().notNull().default(sql`ARRAY['sbom:write']`),
  ```
  With a GIN index if filter-by-scope becomes a hot query.
- A join table `api_key_scopes(api_key_id, scope)` for the fully normalized version.

Not urgent unless scope-based filtering shows up in the product.

---

## P3-11. `vulnerability_sync_status.source` is unique — doubles as PK

### Problem

The table has both `id uuid PK` and `source varchar unique`. Since `source` is
the natural key and nothing references this table, the `id` column is dead
weight.

### Fix

```sql
ALTER TABLE vulnerability_sync_status DROP COLUMN id;
ALTER TABLE vulnerability_sync_status ADD PRIMARY KEY (source);
```

Trivial simplification. Same pattern may apply to `osv_sync_runs` (already uses
`text PK`, good).

---

## P3-12. `component_external_refs.url` is `varchar(2048)`

### Problem

URL length is unbounded in practice. 2048 is generous, but it's still a limit.
If an SBOM upload fails with "value too long for varchar(2048)" the user gets
a confusing error.

### Fix

```sql
ALTER TABLE component_external_refs ALTER COLUMN url TYPE text;
```

Same Postgres storage characteristics, no truncation risk.

---

## Checklist

- [x] P3-1  `users.email` LOWER uniqueness + normalization at write
- [x] P3-2  `organizations.slug` case-insensitive uniqueness
- [x] P3-3  Widen `varchar(n)` → `text` where the cap isn't a product rule
- [ ] P3-4  License dedup strategy — _deferred; non-SPDX licenses are rare in our SBOMs and the author flagged this as "do nothing if rare"._
- [x] P3-5  Pick one idiom for uniqueness / FK declaration — _conventions documented in `server/src/db/schema/README.md`; existing inconsistencies normalized opportunistically._
- [x] P3-6  `component_dependencies.created_at`
- [x] P3-7  Rename / explicit-DESC on `osv_vulns_modified_desc_idx`
- [x] P3-8  `osv_sync_failures (sync_run_id, occurred_at)` composite
- [ ] P3-9  Review `jobs.max_retries` default strategy — _status quo is acceptable; column default of 3 retained, per-job-type overrides remain caller responsibility._
- [x] P3-10 `api_keys.scopes` → `text[]` or join table
- [x] P3-11 Drop `vulnerability_sync_status.id`, promote `source` to PK
- [x] P3-12 `component_external_refs.url` → `text`

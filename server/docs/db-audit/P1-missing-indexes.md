# P1 — Missing Indexes on Real Query Paths

Every item here is a query we actually run, against a column that is **not the
leading edge of any usable index**. At small data volumes Postgres hides these
with seq scans that look "fast enough". They degrade linearly (and sometimes
quadratically because of nested loops) with data size.

Rule of thumb for every entry below: the repository method references a
non-indexed filter column, or references an indexed column in a way the index
cannot satisfy (e.g. filter is on the second column of a composite).

All of these can ship in one migration.

---

## P1-1. `projects (org_id)` and `(org_id, parent_id)`

### Driving queries

`server/src/repositories/project.repository.ts`:

- `findByNameAndOrg(name, orgId)` — filters `(name, org_id)`.
- `findGroupByNameAndOrg(name, orgId)` — filters `(name, org_id, type)`.
- `findByNameAndOrgAndParent(name, orgId, parentId)` — filters `(name, org_id, parent_id)`.

`server/src/controllers/organization.controller.ts:577,585` — counts projects per org.

### Why current indexes don't help

`projects` has only `index("projects_parent_id_idx").on(parentId)`. Nothing leads
with `org_id`.

### Fix

If you ship the P0-2 partial unique indexes, you already cover `(org_id, name)`
and `(org_id, parent_id, name)` for those query shapes. Additionally add:

```sql
CREATE INDEX projects_org_id_idx ON projects (org_id);
```

For the `org_id + type` filter (projects vs groups in org stats), Postgres can
combine this with existing indexes; only add a composite `(org_id, type)` if
EXPLAIN still shows a seq scan after rollout.

---

## P1-2. `org_members (org_id)`

### Driving queries

`server/src/repositories/organization.repository.ts`:

- `getOrgMembers(orgId)` — `WHERE org_id = ?` with JOIN to `users`.
- `removeOrgMember(orgId, userId)` — `(org_id, user_id)` delete.
- `updateMemberRole`, `transferOwnership` — same shape.

### Why current indexes don't help

The PK is `(user_id, org_id)`. Postgres cannot use a composite btree's second
column alone without the leading column. Every `WHERE org_id = ?` scan is linear
in the total member count across all orgs.

### Fix

```sql
CREATE INDEX org_members_org_id_idx ON org_members (org_id);
```

Or reverse the PK to `(org_id, user_id)` — but that breaks existing
`getUserOrganizations(userId)` queries. Simpler to add a secondary index.

---

## P1-3. `api_keys (org_id)`

### Driving query

`server/src/repositories/api-key.repository.ts:getOrgApiKeys(orgId)`:

```ts
return db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId)).orderBy(apiKeys.createdAt);
```

### Why current indexes don't help

`apiKeys` has indexes on `(key_hash, key_prefix)` and `(cluster_id)`. Nothing
for `org_id`.

### Fix

```sql
CREATE INDEX api_keys_org_id_created_at_idx ON api_keys (org_id, created_at);
```

The composite covers the `ORDER BY created_at` as well, letting Postgres avoid
a sort step.

---

## P1-4. `clusters (org_id)`

### Driving query

`server/src/repositories/cluster.repository.ts:findAllByOrg(orgId)`.

### Why current indexes don't help

`clusters` has `uniqueIndex("clusters_name_org_unique").on(name, orgId)`. The
unique index leads with `name`, so `WHERE org_id = ?` alone can't use it.

### Fix

```sql
CREATE INDEX clusters_org_id_idx ON clusters (org_id);
```

Consider also flipping the uniqueness to `(org_id, name)` — most query paths
filter by org first. That would let a single index serve both listing and the
uniqueness constraint.

---

## P1-5. `org_invites (org_id, lower(email))`

### Driving queries

`server/src/repositories/invite.repository.ts`:

- `findExistingInvite(orgId, email)` — `(org_id, email, expires_at > now)`.
- `deleteInvitesByEmail(orgId, email)` — `(org_id, email)`.

### Why current indexes don't help

`org_invites` has `(org_id, expires_at)` and `(invited_by)`. Neither covers the
email filter.

### Fix

Email is already lowercased at write time, so a plain expression index is fine:

```sql
CREATE INDEX org_invites_org_email_idx ON org_invites (org_id, email);
```

If you want belt-and-suspenders (`ensureUserExists` doesn't lowercase — see
P3):

```sql
CREATE INDEX org_invites_org_lower_email_idx ON org_invites (org_id, LOWER(email));
```

Match the repository query.

---

## P1-6. `vulnerability_affected_packages (ecosystem, package_name)` and `(purl)`

### Driving queries

`server/src/repositories/vulnerability.repository.ts:findAffectedPackagesByEcosystemAndName(ecosystem, packageName)`:

```ts
.where(and(
    eq(schema.vulnerabilityAffectedPackages.ecosystem, ecosystem),
    eq(schema.vulnerabilityAffectedPackages.packageName, packageName)
))
```

### Why current indexes don't help

The only index is `(vulnerability_id, package_name)` — can't satisfy a filter
on `(ecosystem, package_name)` without `vulnerability_id`.

### Fix

```sql
CREATE INDEX vuln_affected_pkg_eco_name_idx
  ON vulnerability_affected_packages (ecosystem, package_name);

CREATE INDEX vuln_affected_pkg_purl_idx
  ON vulnerability_affected_packages (purl)
  WHERE purl IS NOT NULL;
```

> **Caveat:** if you act on P2-1 (collapse onto the OSV mirror), you can drop
> this whole table and rely on `osv_affected_packages`, which already has the
> right indexes. Don't add these indexes just to remove the table six months
> later — review P2-1 first.

---

## P1-7. `vulnerabilities (severity_level)`, `(source)`, `(modified_at)`, GIN on `aliases`

### Driving queries

`server/src/repositories/vulnerability.repository.ts`:

- `getVulnerabilityCountBySource()` — `GROUP BY source`.
- `getVulnerabilityCountBySeverity()` — `GROUP BY severityLevel`.
- Implicit future: "recently modified advisories", "find by CVE/GHSA alias".

### Why current indexes don't help

Only `(cvss_score)` is indexed. `GROUP BY` on an unindexed low-cardinality
column is tolerated by Postgres via HashAggregate today, but at 5M+ vuln rows
it becomes visibly slow and memory-heavy.

### Fix

```sql
CREATE INDEX vulnerabilities_severity_level_idx ON vulnerabilities (severity_level);
CREATE INDEX vulnerabilities_source_idx         ON vulnerabilities (source);
CREATE INDEX vulnerabilities_modified_at_idx    ON vulnerabilities (modified_at DESC);
CREATE INDEX vulnerabilities_aliases_gin_idx    ON vulnerabilities USING GIN (aliases);
```

Same P2-1 caveat applies — this table may go away.

---

## P1-8. `jobs` — partial queue index + cleanup indexes

### Driving queries

- `claimNextJobs` (hot path, polled by every worker): filter on
  `(status IN ('pending','scheduled'), scheduled_for)`, ORDER BY
  `priority DESC, created_at ASC`.
- `findRecent(orgId)` — `(org_id, status IN (...))`, ORDER BY `completed_at DESC`.
- `cleanupOld(days)` — `(status IN (...), completed_at <= cutoff)`.

### Why current indexes don't help

`jobs_status_priority_idx(status, priority)` works for the initial filter but:

- It is not partial, so it contains every completed/failed job too — wasted space.
- It doesn't include `created_at`, so Postgres still sorts after filtering.
- Nothing indexes `completed_at`, so `cleanupOld` and `findRecent` scan.

### Fix

```sql
-- Replace jobs_status_priority_idx with a narrower, ordered, partial index
DROP INDEX jobs_status_priority_idx;

CREATE INDEX jobs_queue_idx
  ON jobs (priority DESC, created_at ASC)
  WHERE status IN ('pending', 'scheduled');

CREATE INDEX jobs_completed_at_idx
  ON jobs (completed_at DESC)
  WHERE status IN ('completed', 'failed', 'cancelled');

CREATE INDEX jobs_org_completed_at_idx
  ON jobs (org_id, completed_at DESC)
  WHERE status IN ('completed', 'failed', 'cancelled');
```

Also consider converting `jobs_scheduled_for_idx` into a partial:

```sql
DROP INDEX jobs_scheduled_for_idx;
CREATE INDEX jobs_scheduled_for_idx ON jobs (scheduled_for) WHERE status = 'scheduled';
```

### Impact

`claimNextJobs` is polled by every worker every few seconds. A partial index
keyed exactly on the queue filter is the classic Postgres pattern and makes
the claim O(log(pending_jobs)) instead of O(log(total_jobs)).

---

## P1-9. `organizations` partial indexes for soft-delete filter

### Driving queries

`server/src/repositories/organization.repository.ts`:

- `getOrganizationById(id)` — `WHERE id = ? AND deleted_at IS NULL`.
- `getOrganizationBySlug(slug)` — same shape.
- `getUserOrganizations(userId)` — JOIN with `isNull(organizations.deletedAt)`.

### Why current indexes don't help

`id` is the PK. `slug` is unique. Both are fine for lookup but don't encode the
soft-delete filter, so Postgres fetches the row and then discards it if
`deleted_at IS NOT NULL`.

### Fix

```sql
CREATE UNIQUE INDEX organizations_slug_active_unique
  ON organizations (slug)
  WHERE deleted_at IS NULL;

-- id lookups are PK-bound; no change needed there.
```

Drop the existing `slug unique` in the Drizzle schema and replace with the partial
variant. This also gives you the nice property that a soft-deleted org's slug
becomes available for reuse.

---

## P1-10. `components (sbom_id, is_direct)`

### Driving queries

Any UI tab that lists **direct** dependencies for a project, i.e. combinations
of `WHERE sbom_id = ? AND is_direct = true`. Exists in `projectController.getComponents`
paths and the dependency-overview endpoint.

### Why current indexes don't help

`components_sbom_id_type_idx (sbom_id, type)` handles `(sbom_id, type='library')`
but can't filter by `is_direct` without scanning the matching rows.

### Fix

Two options. Option A (simple):

```sql
CREATE INDEX components_sbom_direct_idx
  ON components (sbom_id)
  WHERE is_direct = true AND type = 'library';
```

Option B (covering index, avoid heap fetch for the direct-only view):

```sql
CREATE INDEX components_sbom_direct_covering_idx
  ON components (sbom_id, id, name, version)
  WHERE is_direct = true;
```

Start with A. Reach for B only if EXPLAIN shows heap fetches dominating.

---

## P1-11. `sboms (image_digest)` and `(project_id, image_digest)`

### Driving queries

`server/src/repositories/sbom.repository.ts:existsByDigestAndProject`:

```ts
.where(and(
    eq(schema.projects.orgId, orgId),
    eq(schema.projects.name, projectName),
    eq(parentProj.name, groupName),
    eq(schema.sboms.imageDigest, imageDigest),
))
```

Called by the **cluster scanner** on every image scan to decide whether to invoke
syft — this runs continuously in every customer cluster.

### Why current indexes don't help

`sboms` has `(project_id, sbom_sha256)` unique, `(project_id, is_current)`,
`(project_id, created_at)`. None cover `image_digest`.

### Fix

```sql
CREATE INDEX sboms_project_image_digest_idx
  ON sboms (project_id, image_digest)
  WHERE image_digest IS NOT NULL;
```

Partial index because only cluster-scanner uploads populate `image_digest`.

---

## Consolidated migration

All of P1 can ship as one Drizzle migration. Rough outline:

```sql
-- projects
CREATE INDEX projects_org_id_idx ON projects (org_id);

-- org_members
CREATE INDEX org_members_org_id_idx ON org_members (org_id);

-- api_keys
CREATE INDEX api_keys_org_id_created_at_idx ON api_keys (org_id, created_at);

-- clusters
CREATE INDEX clusters_org_id_idx ON clusters (org_id);

-- org_invites
CREATE INDEX org_invites_org_email_idx ON org_invites (org_id, email);

-- vulnerability_affected_packages (skip if P2-1 is imminent)
CREATE INDEX vuln_affected_pkg_eco_name_idx ON vulnerability_affected_packages (ecosystem, package_name);
CREATE INDEX vuln_affected_pkg_purl_idx      ON vulnerability_affected_packages (purl) WHERE purl IS NOT NULL;

-- vulnerabilities (skip if P2-1 is imminent)
CREATE INDEX vulnerabilities_severity_level_idx ON vulnerabilities (severity_level);
CREATE INDEX vulnerabilities_source_idx         ON vulnerabilities (source);
CREATE INDEX vulnerabilities_modified_at_idx    ON vulnerabilities (modified_at DESC);
CREATE INDEX vulnerabilities_aliases_gin_idx    ON vulnerabilities USING GIN (aliases);

-- jobs
DROP INDEX jobs_status_priority_idx;
CREATE INDEX jobs_queue_idx            ON jobs (priority DESC, created_at ASC) WHERE status IN ('pending','scheduled');
CREATE INDEX jobs_completed_at_idx     ON jobs (completed_at DESC) WHERE status IN ('completed','failed','cancelled');
CREATE INDEX jobs_org_completed_at_idx ON jobs (org_id, completed_at DESC) WHERE status IN ('completed','failed','cancelled');
DROP INDEX jobs_scheduled_for_idx;
CREATE INDEX jobs_scheduled_for_idx    ON jobs (scheduled_for) WHERE status = 'scheduled';

-- organizations (requires dropping the old slug UNIQUE)
ALTER TABLE organizations DROP CONSTRAINT organizations_slug_key;
CREATE UNIQUE INDEX organizations_slug_active_unique ON organizations (slug) WHERE deleted_at IS NULL;

-- components
CREATE INDEX components_sbom_direct_idx ON components (sbom_id) WHERE is_direct = true AND type = 'library';

-- sboms
CREATE INDEX sboms_project_image_digest_idx ON sboms (project_id, image_digest) WHERE image_digest IS NOT NULL;
```

Use `CREATE INDEX CONCURRENTLY` for everything on tables with live traffic to
avoid blocking writes. Drizzle migrations do not emit `CONCURRENTLY` automatically —
you either hand-edit the generated SQL or split into a raw SQL migration.

## Checklist

- [ ] P1-1  projects `(org_id)`
- [ ] P1-2  org_members `(org_id)`
- [ ] P1-3  api_keys `(org_id, created_at)`
- [ ] P1-4  clusters `(org_id)`
- [ ] P1-5  org_invites `(org_id, email)`
- [ ] P1-6  vulnerability_affected_packages `(ecosystem, package_name)` + `(purl)` *(skip if P2-1)*
- [ ] P1-7  vulnerabilities severity/source/modified/aliases *(skip if P2-1)*
- [ ] P1-8  jobs partial queue + cleanup indexes
- [ ] P1-9  organizations `(slug) WHERE deleted_at IS NULL`
- [ ] P1-10 components `(sbom_id) WHERE is_direct`
- [ ] P1-11 sboms `(project_id, image_digest)`

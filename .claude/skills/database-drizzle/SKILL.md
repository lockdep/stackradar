---
name: database-drizzle
description: >-
  Domain knowledge for PostgreSQL database patterns using Drizzle ORM: schema
  definitions, migrations, repository patterns, and transactions. Use when
  creating tables, writing migrations, adding repositories, or working with
  Drizzle queries.
---

# Database & Drizzle Patterns

## Stack

- **ORM**: Drizzle ORM (`drizzle-orm/postgres-js`)
- **Driver**: `postgres` (postgres.js)
- **Database**: PostgreSQL 18
- **Config**: `server/drizzle.config.ts`
- **Default URL**: `postgres://postgres:postgres@localhost:5444/server`

## DB Instance (`server/src/db/index.ts`)

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const client = postgres(config.database.url);
export const db = drizzle(client, { schema });
export type Database = typeof db;
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
```

## Schema Layout (`server/src/db/schema/`)

One file per domain, all re-exported from `index.ts`:

| File | Tables |
|------|--------|
| `users.ts` | `users` (profile mirror only — Auth.js session tables live in the *client* DB) |
| `organizations.ts` | `organizations` |
| `org-members.ts` | `orgMembers` |
| `org-invites.ts` | `orgInvites` |
| `api-keys.ts` | `apiKeys` (scanner credentials; optionally cluster-scoped via `clusterId`) |
| `clusters.ts` | `clusters` |
| `namespaces.ts` | `namespaces` |
| `workloads.ts` | `workloads` |
| `workload-containers.ts` | `workloadContainers` |
| `helm-releases.ts` | `helmReleases` |
| `gitops-applications.ts` | `gitopsApplications` |
| `images.ts` | `images` (cluster-scoped: identity is `(cluster_id, digest)`, ADR 0006) |
| `sboms.ts` | `sboms` (one per image via `sboms_image_id_unique` — no `is_current` flag) |
| `components.ts` | `components` |
| `component-dependencies.ts` | `componentDependencies` |
| `component-hashes.ts` | `componentHashes` |
| `component-external-refs.ts` | `componentExternalRefs` |
| `component-properties.ts` | `componentProperties` |
| `licenses.ts` | `licenses`, `componentLicenses` |
| `vulnerabilities.ts` | `vulnerabilities`, `vulnerabilityAffectedPackages`, `componentVulnerabilities`, `vulnerabilitySyncStatus` |
| `jobs.ts` | `jobs` |
| `vulnerability-scan-runs.ts` | `vulnerabilityScanRuns` |
| `osv-mirror.ts` | `osvSyncState`, `osvSyncRuns`, `osvSyncFailures` (bookkeeping only — the OSV mirror writes advisories into `vulnerabilities` / `vulnerabilityAffectedPackages`; there are no `osvVulns` / `osvAffectedPackages` tables) |
| `threat-intel.ts` | `epssSyncState`, `kevSyncState` |
| `remediation.ts` | `issues`, `findingStates`, `activityEvents` |
| `chart-repositories.ts` | `chartRepositories`, `chartRepoEntries` |
| `artifact-hub.ts` | `artifactHubPackages`, `artifactHubSyncState` |
| `chart-attributions.ts` | `chartAttributions` |
| `chart-observations.ts` | `chartRenders`, `chartImageObservations` |
| `org-metrics-snapshots.ts` | `orgMetricsSnapshots` |
| `cluster-metrics-snapshots.ts` | `clusterMetricsSnapshots` |

## Table Definition Pattern

```typescript
import { pgTable, uuid, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const things = pgTable("things", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("things_name_org_unique").on(table.name, table.orgId),
]);

export type Thing = typeof things.$inferSelect;
export type NewThing = typeof things.$inferInsert;
```

### Conventions
- **IDs**: `uuid().primaryKey().defaultRandom()` — except high-insert churn tables (`components`, `workload_containers`), which use ``.default(sql`uuidv7()`)`` (PG18) for PK index locality
- **Timestamps**: `timestamp(..., { withTimezone: true }).notNull().defaultNow()` for `createdAt` and `updatedAt`
- **Foreign keys**: `.references(() => table.id, { onDelete: "cascade" })`
- **Indexes**: third argument to `pgTable` returns array
- **Composite PKs**: `primaryKey({ name: "...", columns: [...] })`
- **Type inference**: `$inferSelect` for reads, `$inferInsert` for writes

## Repository Pattern

```typescript
export const imageRepository = {
  async findAll(): Promise<Image[]> {
    return db.select().from(schema.images);
  },
  async findById(id: string): Promise<Image | undefined> {
    const [result] = await db.select().from(schema.images).where(eq(schema.images.id, id));
    return result;
  },
  async create(data: NewImage, tx?: Transaction): Promise<Image> {
    const [result] = await (tx ?? db).insert(schema.images).values(data).returning();
    return result!;
  },
  async update(id: string, data: Partial<NewImage>): Promise<Image | undefined> {
    const [result] = await db.update(schema.images).set(data).where(eq(schema.images.id, id)).returning();
    return result;
  },
  async delete(id: string): Promise<boolean> {
    const result = await db.delete(schema.images).where(eq(schema.images.id, id));
    return result.count > 0;
  },
};
```

### Conventions
- Object of async methods (not a class)
- CRUD naming: `findAll`, `findById`, `create`, `update`, `delete`
- Optional `tx?: Transaction` parameter for transactional operations
- `(tx ?? db)` pattern to support both transactional and standalone calls
- Re-export from `server/src/repositories/index.ts`

## Transactions

```typescript
return db.transaction(async (tx) => {
  const sbom = await sbomRepository.create(data, tx);
  await componentRepository.batchCreate(components, tx);
  return sbom;
});
```

## Migrations (`server/drizzle/`)

- Journal: `drizzle/meta/_journal.json`
- Files: `{index}_{descriptive-name}.sql` (e.g. `0002_add-cvss-score-to-vulnerabilities.sql`)
- Generate: `pnpm db:generate`
- Apply: **never locally** — migrations run only as an ArgoCD pre-sync job on deploy (do not run `pnpm db:migrate`, `db:reset`, or drizzle-kit migrate/push)
- Studio: `pnpm db:studio`

## Common Drizzle Imports

```typescript
import { eq, and, desc, sql, count, inArray } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
```

## Docker Compose Database

- Port: `5444` (mapped to container `5432`)
- Two databases: `client` (NextAuth) and `server` (app data)
- Init script: `scripts/init-db.sql`

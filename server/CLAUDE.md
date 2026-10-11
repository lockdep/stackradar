# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in the `server/` directory.

## Layer Structure

Routes → Controllers → Services (optional) → Repositories → Drizzle ORM → PostgreSQL

| Layer        | Path                                      | Convention                                                  |
| ------------ | ----------------------------------------- | ----------------------------------------------------------- |
| Routes       | `src/routes/{domain}.routes.ts`           | Register in `src/routes/index.ts`                           |
| Controllers  | `src/controllers/{domain}.controller.ts`  | Object of async handlers                                    |
| Services     | `src/services/{domain}.service.ts`        | Business logic, transactions                                |
| Repositories | `src/repositories/{domain}.repository.ts` | Drizzle queries, re-export from `src/repositories/index.ts` |
| Schemas      | `src/schemas/{domain}.schema.ts`          | Zod validation                                              |
| DB schema    | `src/db/schema/{domain}.ts`               | Re-export from `src/db/schema/index.ts`                     |

## Adding a New Feature

1. `src/schemas/{domain}.schema.ts` — Zod request validation
2. `src/db/schema/{domain}.ts` — Drizzle table definition, export from `index.ts`
3. `src/repositories/{domain}.repository.ts` — CRUD methods, export from `index.ts`
4. `src/services/{domain}.service.ts` — if cross-repository logic or transactions needed
5. `src/controllers/{domain}.controller.ts` — request handlers
6. `src/routes/{domain}.routes.ts` — register in `src/routes/index.ts`

## Controller Pattern

```typescript
export const imageController = {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await imageRepository.findAll();
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createThingSchema.parse(req.body);
      const result = await imageRepository.create(data);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
};
```

Do not catch `ZodError` in controllers — the global error handler maps it to a
400 `{ error }` response. Handlers keep a plain `catch (error) { next(error) }`.

## Repository Pattern

```typescript
export const imageRepository = {
  async findById(id: string): Promise<Image | undefined> {
    const [result] = await db.select().from(schema.images).where(eq(schema.images.id, id));
    return result;
  },
  async create(data: NewImage, tx?: Transaction): Promise<Image> {
    const [result] = await (tx ?? db).insert(schema.images).values(data).returning();
    return result!;
  },
};
```

- Use `tx?: Transaction` + `(tx ?? db)` for transactional support
- CRUD naming: `findAll`, `findById`, `create`, `update`, `delete`

## Drizzle Table Pattern

```typescript
export const things = pgTable(
  "things",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("things_name_org_unique").on(table.name, table.orgId)],
);

export type Thing = typeof things.$inferSelect;
export type NewThing = typeof things.$inferInsert;
```

## Database Migrations

> [!IMPORTANT]
> Against the dev and prod databases, migrations are applied **only** by the deploy (ArgoCD PreSync Jobs). Do **not** run `pnpm db:migrate` or `pnpm db:reset` there, and never set `MIGRATE_ON_START` on a cloud Deployment. Authoring migration files with `pnpm db:generate` is fine. Self-hosted installs (and your own local Compose database) apply the chain at boot with `MIGRATE_ON_START=true` via `src/db/migrate.ts`, under an advisory lock shared with the client's migrator — see the root `CLAUDE.md`, "Database Setup".

## Auth Middleware

```typescript
router.get("/", requireAuth, requireInternal, requireOrg, controller.getAll);
```

`req.auth` is set by `requireAuth` and is a discriminated union on `type`:

```typescript
{ type: "internal", userId, user, orgId, org, isAdmin }   // BFF request, acts as a user
{ type: "api_key", orgId, org, apiKey: { id, name, scopes, clusterId? } }  // scanner credential, no user
```

API keys are scanner credentials only. They authenticate the `/v1` ingest
surface (heartbeat, inventory, SBOM upload/check — each gated by
`requireScope("sbom:write")`); **every route under `/api` mounts
`requireInternal` right after `requireAuth`** and answers 403 to a key. An API key context carries no
`userId` — `created_by` is audit metadata, never an acting identity — so role
checks (`requireAdminOrOwner`, `requireAdmin`) can never pass for a key. When
adding a route: management routes get `requireAuth, requireInternal` (+
`requireOrg` as needed); only scanner ingest endpoints omit `requireInternal`.

## Error Handling

- Throw `new AppError(statusCode, message)` for operational errors
- `ZodError` → handled globally by the error handler (400 `{ error }`); never catch it in controllers
- All other errors → `next(error)` → global error handler

## Logging

```typescript
import { createLogger } from "../lib/logger.js";
const log = createLogger("module-name");
```

## Testing

Tests use Testcontainers (real PostgreSQL) — no mocking the DB.

```bash
pnpm test                                          # All tests
pnpm vitest run tests/path/to/file.test.ts         # Single file
pnpm test:watch                                    # Watch mode
```

Integration test pattern — always `cleanAllData()` in `beforeEach`, seed with helpers from `tests/fixtures/seed-data.ts`, authenticate via `createInternalHeaders()`.

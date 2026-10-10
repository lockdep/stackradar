---
name: testing-patterns
description: >-
  Domain knowledge for testing patterns: Vitest configuration, Testcontainers
  for PostgreSQL, integration and unit test conventions, seed data helpers,
  and test utilities. Use when writing tests, setting up test fixtures, or
  working with the test infrastructure.
---

# Testing Patterns

## Stack

| Tool | Purpose |
|------|---------|
| Vitest | Test runner (globals, node environment) |
| Supertest | HTTP integration tests against Express |
| Testcontainers | PostgreSQL container for tests (`@testcontainers/postgresql`) |

## Configuration (`server/vitest.config.ts`)

- Tests: `tests/**/*.test.ts`
- Global setup: `tests/setup/global-setup.ts` (PostgreSQL container + migrations)
- Per-file setup: `tests/setup/test-setup.ts` (DB connection lifecycle)
- Timeout: 30s test, 120s hooks
- Sequential execution (`fileParallelism: false`) — all tests share one DB container
- Alias: `@/` → `./src/`

## Test Infrastructure

### Global Setup (`tests/setup/global-setup.ts`)
- Starts PostgreSQL via `@testcontainers/postgresql` (image: `postgres:18-alpine`)
- Creates `test_server` database
- Runs Drizzle migrations
- Writes connection string to `{tmpdir}/vitest-pg-state.json`

### Per-File Setup (`tests/setup/test-setup.ts`)
- `beforeAll`: `setupTestDatabase()` — reads state file, sets `DATABASE_URL`
- `afterAll`: `teardownTestDatabase()` — closes connection

### Test DB Helpers (`tests/setup/test-db.ts`)
- `getTestDb()` — returns Drizzle instance for assertions
- `cleanTables(tables)` — delete specific tables
- `cleanAllData()` — delete all data in FK-safe order

### Test App (`tests/setup/test-app.ts`)
- `getTestApp()` — lazy-loads Express app after DB setup
- `createInternalHeaders(overrides?)` — builds `X-Internal-Key` + user headers
- `createApiKeyHeaders(apiKey)` — builds `X-API-Key` header

## Directory Layout

```
server/tests/
├── setup/
│   ├── global-setup.ts       # Container + migrations
│   ├── test-setup.ts          # Per-file hooks
│   ├── test-db.ts             # DB helpers
│   ├── test-app.ts            # Express app + auth helpers
│   └── test-config.ts         # POSTGRES_IMAGE constant
├── fixtures/
│   ├── seed-data.ts           # Factory functions
│   └── osv-samples/           # JSON fixture files
├── integration/               # API tests (supertest)
│   ├── api-keys/
│   ├── projects/
│   └── ...
└── unit/                      # Isolated logic tests
    └── osv-sync/
```

## Integration Test Pattern

```typescript
describe("GET /api/projects", () => {
  let app: Express;
  let testData: SeedTestScenarioResult;

  beforeAll(async () => {
    app = await getTestApp();
  });

  beforeEach(async () => {
    await cleanAllData();
    const db = getTestDb();
    testData = await seedTestScenario(db);
  });

  it("should list all projects", async () => {
    const db = getTestDb();
    await createProject(db, testData.org.id, { name: "Project 1" });

    const response = await request(app)
      .get("/api/projects")
      .set(createInternalHeaders({ orgId: testData.org.id }))
      .expect(200);

    expect(response.body).toHaveLength(1);
  });
});
```

### Conventions
- `beforeAll`: get app instance
- `beforeEach`: `cleanAllData()` + seed baseline scenario
- Auth via `createInternalHeaders()` or `createApiKeyHeaders()`
- Assertions on HTTP status and response body

## Unit Test Pattern

```typescript
describe("OsvVulnRepository", () => {
  let db: ReturnType<typeof getTestDb>;
  let repository: OsvVulnRepository;

  beforeAll(() => {
    db = getTestDb();
    repository = createOsvVulnRepository(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE osv_vulns CASCADE`);
  });

  it("should insert a new record", async () => {
    const record = createTestRecord("TEST-001", new Date());
    await repository.upsert([record]);
    // ...
  });
});
```

### Conventions
- Inject DB into modules using factory functions (e.g. `createOsvVulnRepository(db)`)
- Clean with `TRUNCATE ... CASCADE` or `cleanTables()`
- No HTTP layer — test repository/business logic directly

## Seed Helpers (`tests/fixtures/seed-data.ts`)

| Helper | Purpose |
|--------|---------|
| `createUser(db, overrides?)` | Insert a user |
| `createOrganization(db, overrides?)` | Insert an organization |
| `addOrgMember(db, orgId, userId, role)` | Add member to org |
| `createOrgWithOwner(db)` | Org + owner (common combo) |
| `createProject(db, orgId, overrides?)` | Insert a project |
| `createApiKey(db, orgId, overrides?)` | Insert an API key |
| `createExpiredApiKey(db, orgId)` | Expired API key |
| `createRevokedApiKey(db, orgId)` | Revoked API key |
| `seedTestScenario(db)` | Full baseline: org, owner, API key |

## Naming Conventions

- Files: `*.test.ts`
- `describe`: feature or route (e.g. `"GET /api/projects"`, `"OsvVulnRepository"`)
- `it`: behavior starting with `"should ..."` (e.g. `"should list all projects"`)

## Running Tests

```bash
cd server
pnpm test              # Run all tests
pnpm test -- --watch   # Watch mode
```

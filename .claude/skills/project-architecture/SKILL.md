---
name: project-architecture
description: >-
  Domain knowledge for the StackRadar project architecture: BFF proxy pattern,
  Express API layers, authentication flows, middleware, and API conventions.
  Use when adding routes, controllers, services, repositories, middleware, or
  working with auth, error handling, or the BFF proxy.
---

# Project Architecture

## Overview

```
Browser → Next.js BFF (port 3000) → Express API (port 8080) → PostgreSQL
                NextAuth                    Drizzle ORM
```

The Next.js client acts as a BFF (Backend For Frontend), proxying authenticated requests to an internal Express API. The Express API is cluster-only in production.

## Layer Structure

| Layer | Path | Naming | Responsibility |
|-------|------|--------|----------------|
| BFF routes | `client/src/app/api/**/route.ts` | Next.js App Router | Auth check, proxy to Express |
| Express routes | `server/src/routes/*.routes.ts` | `{domain}.routes.ts` | Route registration, middleware |
| Controllers | `server/src/controllers/*.controller.ts` | `{domain}.controller.ts` | Request handling, validation |
| Services | `server/src/services/*.service.ts` | `{domain}.service.ts` | Business logic, transactions |
| Repositories | `server/src/repositories/*.repository.ts` | `{domain}.repository.ts` | Data access (Drizzle) |
| Schemas | `server/src/schemas/*.schema.ts` | `{domain}.schema.ts` | Zod validation schemas |
| Middleware | `server/src/middleware/*.ts` | `auth.ts`, `error-handler.ts` | Cross-cutting concerns |

## BFF Proxy Pattern

The BFF is a single catch-all route, `client/src/app/api/[...path]/route.ts`:
it checks the Auth.js session (401 without one), gates `admin/*` paths on
`session.user.isAdmin` (403), then forwards method, path, query string, body
and Content-Type verbatim to Express at the same `/api/*` path with the
internal headers from `createApiHeaders(session, request)` plus
`X-Request-Id`, and streams the response back. BFF and Express paths map 1:1;
there is no rewrite table.

Explicit route files exist only where a verbatim proxy is impossible, and
they take precedence over the catch-all: `auth/[...nextauth]` (Auth.js),
`health/live` / `health/ready` (probes, no Express upstream), and
`users/setup` (builds its POST body from the session). Adding a normal
API route means adding it on the Express side only.

Key utilities in `client/src/lib/api-utils.ts`:
- `getExpressUrl()` — from `EXPRESS_API_URL` env (default `http://localhost:8080`)
- `createApiHeaders(session, request?)` — async; builds internal headers and resolves the active org from the `sr_org_id` cookie
- `handleApiError(error, reqId?)` — returns 500 JSON
- `getRequestId(request?)` — uses `x-request-id` or generates UUID

## Authentication

### Three Auth Mechanisms

1. **NextAuth** (browser → BFF): GitHub/Google OAuth, database sessions
2. **Internal service key** (BFF → Express): `X-Internal-Key` shared secret
3. **API key** (CI/CD → Express): `X-API-Key` header, format `sk_live_xxxxx`

### Internal Request Headers

| Header | Purpose |
|--------|---------|
| `X-Internal-Key` | Shared secret (BFF ↔ Express) |
| `X-User-Id` | User ID |
| `X-User-Email` | User email |
| `X-User-Name` | Display name (optional) |
| `X-Org-Id` | Organization ID (optional) |
| `X-Org-Name` | Organization name |
| `X-Org-Slug` | Organization slug |
| `X-Org-Plan` | Organization plan |

### Auth Middleware (`server/src/middleware/auth.ts`)

| Middleware | Behavior |
|------------|----------|
| `requireAuth` | Requires internal key or valid API key; sets `req.auth` |
| `optionalAuth` | Same checks, does not fail if unauthenticated |
| `requireScope(scope)` | Enforces API key scope (internal requests bypass) |
| `requireOrg` | Ensures `req.auth.orgId` is set |

```typescript
interface AuthContext {
  type: "api_key" | "internal";
  userId: string;
  user: { id, email, name };
  orgId: string;
  org: { id, name, slug, plan };
  apiKey?: { id, name, scopes[] };
}
```

Auth order: internal key → API key → 401.

## Controller Pattern

Controllers are objects of async handlers:

```typescript
export const projectController = {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const projects = await projectRepository.findAllWithStats();
      res.json(projects);
    } catch (error) {
      next(error);
    }
  },
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createProjectSchema.parse(req.body);
      // ...
    } catch (error) {
      next(error);
    }
  },
};
```

- Validate with Zod schemas from `server/src/schemas/`
- All errors → `next(error)`; the global error handler maps `ZodError` to a 400 `{ error }` — never catch it in controllers
- Controllers call services (where they exist) or repositories directly

## Route Registration

```typescript
// server/src/routes/{domain}.routes.ts
const router = Router();
router.get("/", requireAuth, controller.getAll);
router.post("/", requireAuth, controller.create);
router.get("/:id", requireAuth, controller.getById);

// server/src/routes/index.ts
router.use("/projects", projectRoutes);
router.use("/sboms", sbomRoutes);

// server/src/app.ts
app.use("/v1", publicRoutes);   // Public API (api.stackradar.io)
app.use("/api", routes);        // Internal API (cluster-only)
```

## Error Handling

```typescript
// server/src/middleware/error-handler.ts
export class AppError extends Error {
  constructor(public statusCode: number, public message: string, public isOperational = true) {}
}
```

- Every error response body is `{ error: string }`
- `ZodError` → 400 with the first issue's message
- `AppError` 4xx → `log.warn`; `AppError` 5xx → `log.error`
- Unknown errors → 500 with generic message (never leaks internals), full stack logged

## Logging (Pino)

```typescript
import { createLogger } from "../lib/logger.js";
const log = createLogger("module-name");
```

- Base: `service: "stack-radar-server"`, environment label
- Dev: `pino-pretty` with color
- Prod: JSON output
- pino-http: request IDs via `x-request-id`, sensitive field redaction, health endpoints suppressed in prod

## Adding a New Feature Checklist

1. **Schema**: `server/src/schemas/{domain}.schema.ts` — Zod validation
2. **DB schema**: `server/src/db/schema/{domain}.ts` — Drizzle table, export from `index.ts`
3. **Repository**: `server/src/repositories/{domain}.repository.ts` — CRUD, export from `index.ts`
4. **Service** (if needed): `server/src/services/{domain}.service.ts` — business logic
5. **Controller**: `server/src/controllers/{domain}.controller.ts` — handlers
6. **Routes**: `server/src/routes/{domain}.routes.ts` — register in `index.ts`
7. **BFF route**: `client/src/app/api/{path}/route.ts` — proxy with auth

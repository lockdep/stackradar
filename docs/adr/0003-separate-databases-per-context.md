# Separate databases for auth and application data

**Status:** Superseded 2026-10-10: one database, `auth` schema for the client — see [AGENTS.md § Database Setup](../../AGENTS.md#database-setup).
**Date:** 2026-06-30

> **Why it was superseded.** One database, with the Auth.js tables in a
> Postgres schema named `auth` and the server's data in `public`. The
> ownership boundary this ADR wanted survives as the schema boundary and as
> two Drizzle projects with separate journals; what did not survive was asking
> a self-hoster for two connection strings. The original text follows for the
> record.

Auth.js identity tables (users, sessions, accounts) live in a `client` database; all application data (SBOMs, vulnerabilities, projects, orgs, jobs) lives in a separate `server` database. Both run on a single PostgreSQL 17 instance on the non-standard port **5444**, initialized via `scripts/init-db.sql`.

## Considered Options

Keeping everything in one database was the obvious default. Splitting was chosen so the auth layer (owned by the client/BFF) and the application layer (owned by Express) have independent schemas, migrations, and ownership boundaries — at the cost of no cross-database foreign keys between a `User` and application rows (they reference each other by ID only).
-- First-start initialisation for the local development Postgres
-- (root docker-compose.yml). Runs once, on an empty volume.
--
-- One database serves both apps: the Express server owns the `public`
-- schema and the Next.js client owns the `auth` schema (its Auth.js tables)
-- inside the same database. Each keeps its own Drizzle journal
-- (`drizzle.__drizzle_migrations` / `auth.__drizzle_migrations`), and the
-- apps create the schemas and tables themselves at start-up
-- (MIGRATE_ON_START=true); nothing but the database is created here.
CREATE DATABASE server;
GRANT ALL PRIVILEGES ON DATABASE server TO postgres;

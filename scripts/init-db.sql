-- Create databases for StackRadar
-- This script runs on first container initialization.
--
-- One database for both apps (open-source plan step 05, 10 Oct 2026): the
-- Express server owns `public`, the Next.js client owns the `auth` schema
-- (Auth.js tables) inside the same database, and each keeps its own Drizzle
-- journal (`drizzle.__drizzle_migrations` / `auth.__drizzle_migrations`).
-- The separate `client` database is gone; an existing dev volume still has
-- it, and it is simply unused.
CREATE DATABASE server;
GRANT ALL PRIVILEGES ON DATABASE server TO postgres;

-- Database for the chart index (charts/), with its two roles — the same
-- shape step 13 creates by hand on the managed database: charts_worker owns
-- it (worker + migrations), charts_site can only SELECT (granted by the
-- app's first migration, never here). Dev passwords; charts/.env.example
-- carries the matching URLs.
--
-- Only runs on a fresh volume. An existing dev database gets these by hand:
--   psql postgres://postgres:postgres@localhost:5444/postgres -f scripts/init-db.sql
-- (the CREATE DATABASE lines for client/server will error and can be ignored).
CREATE ROLE charts_worker LOGIN PASSWORD 'charts_worker' CREATEDB;
CREATE ROLE charts_site LOGIN PASSWORD 'charts_site';
CREATE DATABASE stackradar_charts OWNER charts_worker;


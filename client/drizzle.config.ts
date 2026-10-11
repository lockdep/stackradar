import { defineConfig } from 'drizzle-kit';

/**
 * The Auth.js tables live in the `auth` schema of the server's database,
 * so this app's migration journal lives there
 * too: `auth.__drizzle_migrations`, never the default `drizzle.*` the
 * server's chain writes. `scripts/migrate.mjs` (the in-image migrator)
 * must name the same schema and table — `scripts/check-cross-app-constants.mjs`
 * at the repo root checks that it does.
 */
export default defineConfig({
    schema: './src/db/schema/index.ts',
    out: './drizzle',
    dialect: 'postgresql',
    migrations: {
        schema: 'auth',
        table: '__drizzle_migrations',
    },
    dbCredentials: {
        url: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5444/server',
    },
});

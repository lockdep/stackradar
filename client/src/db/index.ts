import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

// The same database as the server's; this app's tables are in its `auth`
// schema (see schema/index.ts). One connection string for both apps.
const connectionString =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5444/server";

const globalForDb = globalThis as unknown as { pgClient: Sql | undefined };

const client =
  globalForDb.pgClient ??
  postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    // DATABASE_CA_CERT holds the PEM of the managed-Postgres CA; when set,
    // connections verify the server's chain against it instead of the
    // sslmode-only behaviour (encrypt, trust any cert) — security review I6.
    ...(process.env.DATABASE_CA_CERT
      ? { ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT } }
      : {}),
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pgClient = client;
}

export const db = drizzle(client, { schema });

export { schema };


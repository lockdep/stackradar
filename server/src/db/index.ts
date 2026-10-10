import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config/index.js";
import * as schema from "./schema/index.js";

// Create postgres connection.
//
// Every process that imports this module (API server, job worker, the
// EPSS/KEV/chart-sync CLIs) gets its own pool of `poolMax` connections —
// budget them together against Postgres max_connections. The session
// timeouts are the production discipline: statement_timeout kills the query
// that hangs forever, and idle_in_transaction_session_timeout stops a wedged
// transaction (an inventory set replacement mid-flight, say) from holding
// its locks indefinitely. Defaults and rationale live in src/config/index.ts.
const client = postgres(config.database.url, {
    max: config.database.poolMax,
    connect_timeout: config.database.connectTimeoutSeconds,
    // Session parameters, sent to Postgres per connection; values in
    // milliseconds as Postgres expects.
    connection: {
        statement_timeout: config.database.statementTimeoutMs,
        idle_in_transaction_session_timeout: config.database.idleInTransactionTimeoutMs,
        // Planner/executor tuning for the finding rollups; rationale next to
        // the defaults in src/config/index.ts.
        jit: config.database.jit,
        work_mem: config.database.workMem,
    },
    // With a CA configured, verify the server's chain against it instead of
    // the sslmode-only behaviour (encrypt, trust any cert) — I6. Omitting
    // the option entirely keeps local no-TLS Postgres working.
    ...(config.database.caCert
        ? { ssl: { rejectUnauthorized: true, ca: config.database.caCert } }
        : {}),
});

// Create drizzle database instance with schema
export const db = drizzle(client, { schema });

// Export schema for convenience
export { schema };

// Export types
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

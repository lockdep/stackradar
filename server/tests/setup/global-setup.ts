import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../../src/db/schema/index.js";
import { POSTGRES_IMAGE } from "./test-config.js";

const STATE_FILE = join(tmpdir(), "vitest-pg-state.json");

let container: StartedPostgreSqlContainer | null = null;

/**
 * Global setup - runs once before all test files
 * Starts a PostgreSQL container and runs migrations
 */
export async function setup(): Promise<void> {
    console.log("\nStarting PostgreSQL test container...");

    // Start PostgreSQL container
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase("test_server")
        .withUsername("test")
        .withPassword("test")
        .start();

    const connectionString = container.getConnectionUri();

    // Run migrations
    const migrationClient = postgres(connectionString, { max: 1 });
    const migrationDb = drizzle(migrationClient, { schema });
    await migrate(migrationDb, { migrationsFolder: "./drizzle" });
    await migrationClient.end();

    // Write state to file for test files to read
    writeFileSync(
        STATE_FILE,
        JSON.stringify({
            connectionString,
            containerId: container.getId(),
        }),
    );

    console.log("Test database ready\n");
}

/**
 * Global teardown - runs once after all test files
 */
export async function teardown(): Promise<void> {
    console.log("\nCleaning up test container...");

    if (container) {
        await container.stop();
    }

    // Clean up state file
    if (existsSync(STATE_FILE)) {
        unlinkSync(STATE_FILE);
    }

    console.log("Cleanup complete\n");
}

/**
 * Get the state file path (for use by test-db.ts)
 */
export function getStateFilePath(): string {
    return STATE_FILE;
}

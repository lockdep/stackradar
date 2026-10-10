import { readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema/index.js";

const STATE_FILE = join(tmpdir(), "vitest-pg-state.json");

let connectionString: string = "";
let testDb: PostgresJsDatabase<typeof schema> | null = null;
let testClient: postgres.Sql | null = null;
let initialized = false;

function readConnectionString(): string {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      "Test state file not found. Make sure global setup has run."
    );
  }
  const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  return state.connectionString as string;
}

/**
 * Point the app's own config at the test container.
 *
 * Must run before any `src/` module is evaluated: `config/index.ts` snapshots
 * `process.env.DATABASE_URL` at module-eval time, and `db/index.ts` opens its
 * pool from that snapshot. Anything that transitively imports the logger
 * (which imports config) freezes the `localhost:5444` fallback if this has not
 * run yet — a test file that statically imports, say, `osv-sync/state.ts` and
 * then calls a service using the app's `db` fails with ECONNREFUSED on 5444.
 * `test-setup.ts` therefore calls this at its top level, which vitest runs
 * before the test file's own imports; the beforeAll path below is idempotent.
 */
export function exportTestEnv(): void {
  connectionString = readConnectionString();

  process.env.DATABASE_URL = connectionString;
  process.env.INTERNAL_SERVICE_KEY = "test-internal-key-12345";
  process.env.NODE_ENV = "test";
  // The cloud is the superset of the surface, so it is what the suite runs
  // as unless told otherwise; `STACKRADAR_EDITION=community pnpm test` runs
  // the community edition and the cloud-only suites skip themselves.
  process.env.STACKRADAR_EDITION = process.env.STACKRADAR_EDITION || "cloud";
  // Stripe keys must be non-empty so config doesn't throw; Stripe is mocked in billing tests
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_fake";
  // A fixed vault key so minted keys are revealable in tests; the vault
  // unit test constructs its own vaults and does not depend on this one.
  process.env.API_KEY_ENCRYPTION_KEY =
    process.env.API_KEY_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}

/**
 * Initialize the test database connection from state file
 * Called lazily when getTestDb() is first invoked
 */
function initializeFromState(): void {
  if (initialized) return;

  exportTestEnv();

  // Create the test client
  testClient = postgres(connectionString);
  testDb = drizzle(testClient, { schema });

  initialized = true;
}

/**
 * Legacy function - kept for compatibility but now a no-op
 * Global setup handles container creation
 */
export async function setupTestDatabase(): Promise<string> {
  initializeFromState();
  return connectionString;
}

/**
 * Legacy function - kept for compatibility but now a no-op
 * Global teardown handles container cleanup
 */
export async function teardownTestDatabase(): Promise<void> {
  if (testClient) {
    await testClient.end();
    testClient = null;
    testDb = null;
    initialized = false;
  }
}

/**
 * Get the test database instance
 */
export function getTestDb(): PostgresJsDatabase<typeof schema> {
  if (!testDb) {
    throw new Error("Test database not initialized. Call setupTestDatabase first.");
  }
  return testDb;
}

/**
 * Get the underlying postgres client (needed for advisory locks via reserved connections)
 */
export function getTestPgClient(): postgres.Sql {
  if (!testClient) {
    throw new Error("Test database not initialized. Call setupTestDatabase first.");
  }
  return testClient;
}

/**
 * Clean all business data tables (preserves users for auth context)
 */
export async function cleanAllData(): Promise<void> {
  const db = getTestDb();

  // Delete in order respecting foreign key constraints
  // Child tables first, parent tables last
  await db.delete(schema.apiKeys);
  // Global, not tenant data: nothing cascades into it, and a chain left by one
  // file would name a base image in the next.
  await db.delete(schema.knownLayerPrefixes);
  await db.delete(schema.feedback);
  await db.delete(schema.digestSends);
  await db.delete(schema.alertSends);
  await db.delete(schema.orgMetricsSnapshots);
  await db.delete(schema.orgMembers);
  await db.delete(schema.orgInvites);
  await db.delete(schema.componentProperties);
  await db.delete(schema.componentDependencies);
  await db.delete(schema.licenses);
  // Before `vulnerabilities`, and not optional: comp_vuln_vuln_fk is RESTRICT,
  // not CASCADE, so a leftover match row makes the delete below throw. Omitting
  // it made every test that inserts matches responsible for its own cleanup, and
  // the cost of forgetting landed on whichever file ran *next* — files share one
  // database and run sequentially, so the failure surfaced as an unrelated suite
  // failing to clear `vulnerabilities`.
  await db.delete(schema.componentVulnerabilities);
  await db.delete(schema.vulnerabilities);
  await db.delete(schema.components);
  await db.delete(schema.vulnerabilityScanRuns);
  await db.delete(schema.sboms);
  await db.delete(schema.jobs);
  // Containment chain, bottom-up. `workload_containers.image_id` is RESTRICT,
  // so images cannot go before the containers that reference them — the FK is
  // there to stop a live image being deleted, and it applies to test teardown
  // exactly as it applies to production.
  await db.delete(schema.workloadContainers);
  // History intervals SET NULL on workload/image deletion and cascade from
  // clusters, so ordering is free; explicit so a leaked open interval never
  // reads as "already running" in the next file's inventory diff.
  await db.delete(schema.workloadContainerHistory);
  await db.delete(schema.activityEvents);
  await db.delete(schema.workloads);
  await db.delete(schema.helmReleases);
  await db.delete(schema.gitopsApplications);
  await db.delete(schema.namespaces);
  // Images reference clusters since ADR 0006 (`images_cluster_id_org_id_fk`,
  // NO ACTION), so the cluster rows can only go after their images.
  await db.delete(schema.images);
  await db.delete(schema.clusters);
  await db.delete(schema.organizations);
  await db.delete(schema.users);
  // Global tables (no org_id) — nothing cascades from `organizations`, so a
  // leaked row would poison whichever test file runs next. Attributions are
  // org-scoped but reference the global mirror, so they go first regardless
  // of which cascade path fires.
  await db.delete(schema.chartAttributions);
  await db.delete(schema.artifactHubPackages);
  await db.delete(schema.artifactHubSyncState);
  await db.delete(schema.epssSyncState);
  await db.delete(schema.kevSyncState);
  // Provenance-free chart observations (measuring-candidate-charts.md) —
  // global like the mirror, and equally capable of poisoning the next file.
  await db.delete(schema.chartImageObservations);
  await db.delete(schema.chartRenders);
}

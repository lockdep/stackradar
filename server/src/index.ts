import "dotenv/config";
import app from "./app.js";
import { config, validateConfig } from "./config/index.js";
import { runMigrations } from "./db/migrate.js";
import { edition } from "./edition.js";
import { startJobWorker, type JobWorkerHandle } from "./jobs/job-worker.js";
import { readBootstrapCluster } from "./lib/bootstrap-cluster.js";
import { logger } from "./lib/logger.js";
import { ensureDefaultOrganization } from "./services/default-org.service.js";
import { startSyncScheduler, type SyncSchedulerHandle } from "./sync-scheduler.js";
import { topology } from "./topology.js";

async function main(): Promise<void> {
  validateConfig();

  // Self-hosted installs apply their own migrations here, serialised across
  // replicas by an advisory lock (db/migrate.ts); the cloud runs a deploy
  // Job instead and leaves both flags unset. With MIGRATE_EXIT_AFTER the
  // process is that Job: migrate, report, exit, never listen.
  if (config.migrations.onStart) {
    const startedAt = Date.now();
    await runMigrations({ url: config.database.url, caCert: config.database.caCert });
    logger.info({ durationMs: Date.now() - startedAt }, "Database migrations applied");
    if (config.migrations.exitAfter) {
      logger.info("MIGRATE_EXIT_AFTER is set; exiting without starting the server");
      // Explicit: importing app.js builds the connection pool and whatever
      // else holds the event loop, and the initializer Job must end here.
      logger.flush();
      process.exit(0);
    }
  }

  // The community edition's one organisation and one cluster exist before
  // anyone has logged in (docs/open-source-plan-2026-10-10.md step 03):
  // the first sign-in owns the organisation, and the scanner the chart
  // installed alongside authenticates with the bootstrap key from the
  // moment the server listens. Idempotent, so every replica runs it. The
  // cloud never does — there every organisation is a tenant's own.
  if (!edition.isCloud) {
    const seeded = await ensureDefaultOrganization(readBootstrapCluster(process.env));
    logger.info(
      { orgId: seeded.orgId, clusterId: seeded.clusterId },
      seeded.clusterId
        ? "Community edition: default organization and bootstrap cluster ready"
        : "Community edition: default organization ready; no bootstrap cluster configured",
    );
  }

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, edition: edition.edition, topology },
      `Server running on http://localhost:${config.port}`
    );
  });

  // The monolith (`src/topology.ts`, the community default) is the whole
  // backend in one process: the job worker loop and the feed scheduler
  // start beside the listener, after it, so the readiness probe answers
  // while a fresh install's OSV bootstrap runs behind it. The cloud's split
  // topology runs both as their own workloads and starts nothing here.
  let worker: JobWorkerHandle | null = null;
  let scheduler: SyncSchedulerHandle | null = null;
  if (topology === "monolith") {
    worker = startJobWorker();
    scheduler = startSyncScheduler();
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal, topology }, "Shutting down");
    server.close();
    worker?.stop();
    void Promise.all([worker?.done, scheduler?.stop()])
      .catch((error: unknown) => logger.error({ err: error }, "Error while stopping background work"))
      .finally(() => {
        logger.flush();
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Server failed to start");
  process.exit(1);
});

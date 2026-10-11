#!/usr/bin/env node
/**
 * Job Worker — the split topology's own process (`src/topology.ts`).
 *
 * Polls the jobs table and processes pending jobs; the loop and its crons
 * live in `jobs/job-worker.ts`, which the monolith server runs in-process
 * instead. This file is the signal handling and the exit code.
 *
 * Usage:
 *   pnpm worker              Start the worker (polls every 5s)
 *   pnpm worker --once       Process ready jobs once and exit
 *
 * Environment variables: see `jobs/job-worker.ts`.
 */

import "dotenv/config";
import { runJobWorkerOnce, startJobWorker, type JobWorkerHandle } from "./jobs/job-worker.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("job-worker");

let handle: JobWorkerHandle | null = null;

function shutdown(signal: string): void {
    log.info({ signal }, "Shutting down job worker");
    handle?.stop();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes("--once")) {
        log.info("Running single poll cycle");
        const processed = await runJobWorkerOnce();
        log.info({ processed }, "Single poll cycle complete");
        process.exit(0);
    }

    handle = startJobWorker();
    await handle.done;
    log.info("Job worker stopped");
}

main().catch((error) => {
    log.error({ error }, "Fatal worker error");
    process.exit(1);
});

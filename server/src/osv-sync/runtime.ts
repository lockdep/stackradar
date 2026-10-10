/**
 * The wired-up OSV sync — every module in this directory assembled around
 * one Postgres client — for the two things that run it: the CLI
 * (`cli.ts`, the cloud's CronJobs) and the monolith's in-process scheduler
 * (`../sync-scheduler.ts`). Both used to be, or would have been, a copy of
 * the same twelve lines.
 *
 * Its own client rather than the app pool (`db/index.ts`) on purpose, with
 * the same planner settings and **no** `statement_timeout`: a bootstrap's
 * statements legitimately run for minutes, and the advisory lock is
 * session-level, so it must live on a connection the sync owns.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config as serverConfig } from "../config/index.js";
import * as schema from "../db/schema/index.js";
import { loadConfig, type OsvSyncConfig } from "./config.js";
import { createSyncStateManager, type SyncStateManager } from "./state.js";
import { createDownloader } from "./downloader.js";
import { createZipProcessor } from "./zip-processor.js";
import { createOsvAffectedPackageRepository, type OsvAffectedPackageRepository } from "./affected-package-repository.js";
import { createOsvSyncFailureRepository } from "./failure-repository.js";
import { createOsvSyncRunRepository } from "./run-repository.js";
import { createOsvSyncWorker, type OsvSyncWorker } from "./worker.js";

export interface OsvSyncRuntime {
    config: OsvSyncConfig;
    worker: OsvSyncWorker;
    stateManager: SyncStateManager;
    affectedPkgRepository: OsvAffectedPackageRepository;
    /** Release the advisory lock, if held, and close the client. */
    close(): Promise<void>;
}

export interface OsvSyncRuntimeOptions {
    config?: OsvSyncConfig;
    /**
     * Connections this runtime may hold. The CLI takes postgres.js's default
     * (10): it is the only thing in its process. The monolith scheduler
     * shares a process with the API pool and asks for fewer.
     */
    poolMax?: number;
}

export function createOsvSyncRuntime(options: OsvSyncRuntimeOptions = {}): OsvSyncRuntime {
    const config = options.config ?? loadConfig();

    // Same planner/executor settings as the server pool (src/db/index.ts):
    // the bulk inserts and the generation swap sort and hash far more than
    // the instance's 2 MB work_mem holds.
    const client = postgres(config.databaseUrl, {
        ...(options.poolMax !== undefined && { max: options.poolMax }),
        connection: { jit: serverConfig.database.jit, work_mem: serverConfig.database.workMem },
        ...(serverConfig.database.caCert
            ? { ssl: { rejectUnauthorized: true, ca: serverConfig.database.caCert } }
            : {}),
    });
    const db = drizzle(client, { schema });

    const stateManager = createSyncStateManager(db, client);
    const downloader = createDownloader(config);
    const zipProcessor = createZipProcessor(downloader);
    const affectedPkgRepository = createOsvAffectedPackageRepository(db);
    const failureRepository = createOsvSyncFailureRepository(db);
    const runRepository = createOsvSyncRunRepository(db);
    const worker = createOsvSyncWorker(
        config,
        stateManager,
        downloader,
        zipProcessor,
        affectedPkgRepository,
        failureRepository,
        runRepository
    );

    return {
        config,
        worker,
        stateManager,
        affectedPkgRepository,
        async close(): Promise<void> {
            await worker.shutdown();
            await client.end({ timeout: 5 });
        },
    };
}

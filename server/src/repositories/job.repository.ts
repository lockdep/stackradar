import { eq, ne, and, lte, desc, asc, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Job, NewJob, JobStatus, JobType } from "../db/schema/jobs.js";

export const jobRepository = {
    /**
     * Find all jobs for an organization with optional filters
     */
    async findByOrg(
        orgId: string,
        options?: {
            imageId?: string;
            status?: JobStatus | JobStatus[];
            type?: JobType | JobType[];
            limit?: number;
            offset?: number;
        },
    ): Promise<Job[]> {
        const conditions = [eq(schema.jobs.orgId, orgId)];

        if (options?.imageId) {
            conditions.push(eq(schema.jobs.imageId, options.imageId));
        }

        if (options?.status) {
            if (Array.isArray(options.status)) {
                conditions.push(inArray(schema.jobs.status, options.status));
            } else {
                conditions.push(eq(schema.jobs.status, options.status));
            }
        }

        if (options?.type) {
            if (Array.isArray(options.type)) {
                conditions.push(inArray(schema.jobs.type, options.type));
            } else {
                conditions.push(eq(schema.jobs.type, options.type));
            }
        }

        let query = db
            .select()
            .from(schema.jobs)
            .where(and(...conditions))
            .orderBy(desc(schema.jobs.createdAt));

        if (options?.limit) {
            query = query.limit(options.limit) as typeof query;
        }
        if (options?.offset) {
            query = query.offset(options.offset) as typeof query;
        }

        return query;
    },

    /**
     * Find the most recent vulnerability scan for an image, considering both
     * manual ("vulnerability_scan") and recurring ("scheduled_scan") scans —
     * both produce vulnerability data, so either one means the SBOM has been
     * (or is being) scanned.
     *
     * Future-scheduled placeholder rows (status "scheduled") are excluded so a
     * pending recurring scan can't mask an already-completed scan.
     */
    async findLatestVulnScanForImage(imageId: string): Promise<Job | undefined> {
        const results = await db
            .select()
            .from(schema.jobs)
            .where(
                and(
                    eq(schema.jobs.imageId, imageId),
                    inArray(schema.jobs.type, ["vulnerability_scan", "scheduled_scan"]),
                    ne(schema.jobs.status, "scheduled"),
                ),
            )
            .orderBy(desc(schema.jobs.createdAt))
            .limit(1);
        return results[0];
    },

    /**
     * Find a job by ID
     */
    async findById(id: string): Promise<Job | undefined> {
        const results = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
        return results[0];
    },

    /**
     * Atomically claim the next available jobs for processing.
     *
     * Uses SELECT ... FOR UPDATE SKIP LOCKED inside a transaction so that
     * multiple worker instances never claim the same job. Each worker gets
     * a disjoint set of jobs.
     */
    async claimNextJobs(limit = 5): Promise<Job[]> {
        return db.transaction(async (tx) => {
            const now = new Date();

            const locked = await tx.execute<{ id: string }>(sql`
                SELECT id FROM ${schema.jobs}
                WHERE (status = 'pending' AND scheduled_for IS NULL)
                   OR (status = 'scheduled' AND scheduled_for <= ${now.toISOString()})
                ORDER BY priority DESC, created_at ASC
                LIMIT ${sql.raw(String(limit))}
                FOR UPDATE SKIP LOCKED
            `);

            if (locked.length === 0) return [];

            const ids = Array.from(locked as Iterable<{ id: string }>, (row) => row.id);

            return tx
                .update(schema.jobs)
                .set({
                    status: "processing",
                    startedAt: now,
                    updatedAt: now,
                })
                .where(inArray(schema.jobs.id, ids))
                .returning();
        });
    },

    /**
     * ADMIN / WORKER USE ONLY — returns every currently-processing job
     * across every organisation. Used by `server/src/worker.ts` to recover
     * stale jobs after a restart. Must NEVER be wired to an HTTP route.
     */
    async findAllProcessing(): Promise<Job[]> {
        return db
            .select()
            .from(schema.jobs)
            .where(eq(schema.jobs.status, "processing"))
            .orderBy(asc(schema.jobs.startedAt));
    },

    /**
     * Create a new job
     */
    async create(data: NewJob): Promise<Job> {
        const [result] = await db
            .insert(schema.jobs)
            .values({
                ...data,
                status: data.scheduledFor && data.scheduledFor > new Date() ? "scheduled" : "pending",
            })
            .returning();
        return result!;
    },

    /**
     * Update a job
     */
    async update(id: string, data: Partial<NewJob>): Promise<Job | undefined> {
        const results = await db
            .update(schema.jobs)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(schema.jobs.id, id))
            .returning();
        return results[0];
    },

    /**
     * Start processing a job
     */
    async startProcessing(id: string): Promise<Job | undefined> {
        const results = await db
            .update(schema.jobs)
            .set({
                status: "processing",
                startedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(schema.jobs.id, id))
            .returning();
        return results[0];
    },

    /**
     * Update job progress
     */
    async updateProgress(id: string, progress: number, message?: string): Promise<Job | undefined> {
        const results = await db
            .update(schema.jobs)
            .set({
                progress: Math.min(100, Math.max(0, progress)),
                progressMessage: message,
                updatedAt: new Date(),
            })
            .where(eq(schema.jobs.id, id))
            .returning();
        return results[0];
    },

    /**
     * Mark a job as completed
     */
    async complete(id: string, result?: Record<string, unknown>): Promise<Job | undefined> {
        const results = await db
            .update(schema.jobs)
            .set({
                status: "completed",
                completedAt: new Date(),
                progress: 100,
                result,
                updatedAt: new Date(),
            })
            .where(eq(schema.jobs.id, id))
            .returning();
        return results[0];
    },

    /**
     * Mark a job as failed
     */
    async fail(id: string, errorCode: string, errorMessage: string): Promise<Job | undefined> {
        const job = await this.findById(id);
        if (!job) return undefined;

        const results = await db
            .update(schema.jobs)
            .set({
                status: "failed",
                completedAt: new Date(),
                errorCode,
                errorMessage,
                retryCount: job.retryCount + 1,
                updatedAt: new Date(),
            })
            .where(eq(schema.jobs.id, id))
            .returning();
        return results[0];
    },

    /**
     * Delete a job
     */
    async delete(id: string): Promise<boolean> {
        const results = await db.delete(schema.jobs).where(eq(schema.jobs.id, id)).returning();
        return results.length > 0;
    },

    /**
     * The open (pending or processing) job of one type whose params carry
     * `key = value`, if any. Dedup for user-triggered jobs: a second click
     * while one is queued returns the queued job rather than stacking work.
     */
    async findOpenByParam(type: JobType, key: string, value: string): Promise<Job | undefined> {
        const [job] = await db
            .select()
            .from(schema.jobs)
            .where(
                and(
                    eq(schema.jobs.type, type),
                    inArray(schema.jobs.status, ["pending", "processing"]),
                    sql`${schema.jobs.params} ->> ${key} = ${value}`,
                ),
            )
            .limit(1);
        return job;
    },

    /**
     * The params of every open (pending or processing) job of one type,
     * projected through `keyOf` into a set for membership checks.
     *
     * The enqueue passes (chart renders, platform scans) use this to skip
     * work that is already queued. Each caller keeps its own notion of what
     * identifies a job in its params; this owns the "open jobs" query they
     * all otherwise had to spell out.
     */
    async openParamKeys<K>(type: JobType, keyOf: (params: Record<string, unknown>) => K): Promise<Set<K>> {
        const open = await db
            .select({ params: schema.jobs.params })
            .from(schema.jobs)
            .where(and(eq(schema.jobs.type, type), inArray(schema.jobs.status, ["pending", "processing"])));
        return new Set(open.map((j) => keyOf((j.params ?? {}) as Record<string, unknown>)));
    },

    /**
     * Param keys of jobs of `type` that failed with `errorCode`, until
     * `cleanupOld` ages the rows out. How a refusal that will not change
     * on retry (IMAGE_TOO_LARGE) stays refused instead of being re-queued
     * by every sweep that finds the digest still unscanned.
     */
    async failedParamKeys<K>(
        type: JobType,
        errorCode: string,
        keyOf: (params: Record<string, unknown>) => K,
    ): Promise<Set<K>> {
        const failed = await db
            .select({ params: schema.jobs.params })
            .from(schema.jobs)
            .where(
                and(eq(schema.jobs.type, type), eq(schema.jobs.status, "failed"), eq(schema.jobs.errorCode, errorCode)),
            );
        return new Set(failed.map((j) => keyOf((j.params ?? {}) as Record<string, unknown>)));
    },

    /**
     * Clean up old completed/failed/cancelled jobs
     */
    /**
     * Put a failed job back in the queue as if it were new: `pending`, the
     * retry budget restored, the error cleared. Only a `failed` job — a
     * pending or running one is already moving, and resetting a completed
     * one would re-run work nobody asked for — so the WHERE is the guard and
     * `undefined` means "not failed, nothing done".
     */
    async resetForRetry(id: string): Promise<Job | undefined> {
        const [result] = await db
            .update(schema.jobs)
            .set({
                status: "pending",
                retryCount: 0,
                errorCode: null,
                errorMessage: null,
                startedAt: null,
                completedAt: null,
                progress: 0,
                progressMessage: null,
                updatedAt: new Date(),
            })
            .where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, "failed")))
            .returning();
        return result;
    },

    /**
     * The same reset for every job that has spent its retries — the
     * Overview's "out of retries" figure, as an action. Bounded by what is
     * stuck *now*: a job that fails again lands back in the set with its
     * budget spent, and the next click is a person deciding again.
     */
    async resetAllStuck(): Promise<number> {
        const rows = await db
            .update(schema.jobs)
            .set({
                status: "pending",
                retryCount: 0,
                errorCode: null,
                errorMessage: null,
                startedAt: null,
                completedAt: null,
                progress: 0,
                progressMessage: null,
                updatedAt: new Date(),
            })
            .where(and(eq(schema.jobs.status, "failed"), sql`${schema.jobs.retryCount} >= ${schema.jobs.maxRetries}`))
            .returning({ id: schema.jobs.id });
        return rows.length;
    },

    async cleanupOld(daysOld = 30): Promise<number> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - daysOld);

        const results = await db
            .delete(schema.jobs)
            .where(
                and(
                    inArray(schema.jobs.status, ["completed", "failed", "cancelled"]),
                    lte(schema.jobs.completedAt, cutoff),
                ),
            )
            .returning();

        return results.length;
    },
};

import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { cloudConfigProblems, communityConfigProblems } from "../config/index.js";
import { edition } from "../edition.js";

const router = Router();

// Liveness probe - just checks if the process is alive
// Should NOT check external dependencies
router.get("/live", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
});

/**
 * Readiness probe — can this pod take traffic.
 *
 * Two checks. The database, because nothing works without it. And the
 * edition's configuration: the cloud edition boots without its Stripe and
 * Resend secrets (they are not boot blockers, see `config/index.ts`), so
 * this is where a cloud pod missing them is kept out of the Service; the
 * community edition boots without its bootstrap cluster credential, and
 * this is where that is reported. A blocking problem is a 503 with the
 * variable named (never its value); a warning is reported and the pod
 * stays ready.
 */
router.get("/ready", async (_req: Request, res: Response) => {
    const cloud = cloudConfigProblems();
    const community = communityConfigProblems();
    const problems = {
        blocking: [...cloud.blocking, ...community.blocking],
        warnings: [...cloud.warnings, ...community.warnings],
    };
    const checks: {
        database: "ok" | "error";
        configuration: "ok" | "error";
        error?: string;
        blocking?: string[];
        warnings?: string[];
    } = {
        database: "ok",
        configuration: problems.blocking.length === 0 ? "ok" : "error",
    };
    if (problems.blocking.length > 0) checks.blocking = problems.blocking;
    if (problems.warnings.length > 0) checks.warnings = problems.warnings;

    try {
        // Verify database connection with a simple query
        await db.execute(sql`SELECT 1`);
    } catch (error) {
        checks.database = "error";
        checks.error = error instanceof Error ? error.message : "Unknown database error";
    }

    const isReady = checks.database === "ok" && checks.configuration === "ok";

    res.status(isReady ? 200 : 503).json({
        status: isReady ? "ready" : "not_ready",
        edition: edition.edition,
        checks,
    });
});

// Legacy endpoint for backwards compatibility
router.get("/", (_req: Request, res: Response) => {
    res.json({ ok: true });
});

export default router;

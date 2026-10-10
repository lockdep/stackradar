import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { config } from "../config/index.js";
import { matchRequestSchema, MATCH_MAX_COMPONENTS } from "../schemas/match.schema.js";
import { matchComponents } from "../services/match.service.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("match");

/**
 * `POST /internal/match` — see `docs/contracts/match-endpoint.md`.
 *
 * Its own key, not `INTERNAL_SERVICE_KEY`: that one lets a caller assert a
 * user identity in headers, and the charts worker must never hold it. This
 * key opens exactly one stateless read. The router is mounted by `app.ts`
 * only when `MATCH_SERVICE_KEY` is set (see there).
 */

function digest(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

/** Constant-time compare of `X-Match-Key` against the configured key. */
export function requireMatchKey(req: Request, res: Response, next: NextFunction): void {
    const presented = req.headers["x-match-key"];
    const expected = config.match.serviceKey;
    if (
        !expected ||
        typeof presented !== "string" ||
        presented === "" ||
        !timingSafeEqual(digest(presented), digest(expected))
    ) {
        res.status(401).json({ error: "unauthorized" });
        return;
    }
    next();
}

const router = Router();

router.post("/", requireMatchKey, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
        // The cap is checked on the raw body before Zod walks it: 413 is the
        // one answer whose cause is the size, and there is no point validating
        // twenty thousand components to say so.
        const raw = (req.body ?? {}) as { components?: unknown };
        if (Array.isArray(raw.components) && raw.components.length > MATCH_MAX_COMPONENTS) {
            res.status(413).json({ error: "too_many_components", max: MATCH_MAX_COMPONENTS });
            return;
        }

        const parsed = matchRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(422).json({
                error: "invalid_body",
                issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            });
            return;
        }

        const startedAt = Date.now();
        const response = await matchComponents(parsed.data.components);
        // Counts and timing only — never the components: they describe an
        // image the server has no business remembering.
        log.info(
            {
                components: parsed.data.components.length,
                findings: response.findings.length,
                durationMs: Date.now() - startedAt,
            },
            "Matched components for the chart index"
        );
        res.json(response);
    })().catch(next);
});

export default router;

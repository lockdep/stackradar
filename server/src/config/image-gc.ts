import { getPlanLimits } from "./plans.js";
import { envPositiveNumber } from "../lib/env.js";

/**
 * How long an image nothing refers to is kept before the GC collects it.
 *
 * Lives here rather than in `worker.ts` because two processes have to agree on
 * it. The worker subtracts it from now to get the cutoff it deletes against;
 * the API server subtracts an image's `last_seen_at` from it to tell an admin
 * how long that image has left. If the two read different values the countdown
 * on the dashboard is a fiction — images would vanish before it reached zero,
 * or sit at "due" for days without being collected.
 *
 * A month of nobody mentioning a digest — no inventory report, no SBOM upload.
 * Long enough that a paused cluster or a seasonal workload comes back to its
 * SBOM intact; the cost of being wrong is a re-pull and a re-scan.
 *
 * Read through `lib/env.ts` like the worker's other knobs: an unset, empty,
 * unparseable or non-positive value falls back rather than poisoning the
 * cutoff with `NaN` — a `NaN` cutoff makes `last_seen_at < cutoff` false for
 * every row, which fails safe (collects nothing) but silently.
 */
export const IMAGE_GC_RETENTION_DAYS = envPositiveNumber("IMAGE_GC_RETENTION_DAYS", 30);

/**
 * How long *this org's* unreferenced images are kept: the plan's history
 * window (`PLAN_LIMITS[plan].historyDays` — the SBOM archive is one of the
 * things a paid plan's history buys), floored by `IMAGE_GC_RETENTION_DAYS`
 * so the env knob can only ever lengthen the window, never cut a paid plan's
 * archive short. Unknown plan values fall back to free via `getPlanLimits`,
 * matching every other limit check.
 *
 * The GC sweep (`deleteOrphanedImages`) evaluates the same
 * floor-of-plan-window rule in SQL; the admin countdown calls this function.
 * If the rule changes, both must change together or the countdown lies.
 */
export function imageGcRetentionDays(plan: string): number {
    return Math.max(IMAGE_GC_RETENTION_DAYS, getPlanLimits(plan).historyDays);
}

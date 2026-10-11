import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireMatchKey } from "./match.routes.js";
import { recordKnownChains } from "../services/base-image.service.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("known-images");

/**
 * `POST /internal/known-images` — the public chart index tells the product
 * which public images it has seen and what their layers are, so a customer's
 * image can be recognised as *built on* one (`known_layer_prefixes`,
 * `lib/base-image.ts` signal 2) or as *being* one (`lib/image-control.ts`).
 * Contract: `docs/contracts/match-endpoint.md` § Known images.
 *
 * The match endpoint's sibling, same direction and the same key
 * (`X-Match-Key`): the charts worker already holds it, and what it opens here
 * is one idempotent insert of public facts — an image reference anyone can
 * pull and the diff ids in its config. Nothing is read back.
 */

const MAX_IMAGES = 500;

const bodySchema = z.object({
    images: z
        .array(
            z.object({
                imageRef: z.string().trim().min(1).max(1024),
                diffIds: z
                    .array(z.string().regex(/^sha256:[0-9a-f]{64}$/))
                    .min(1)
                    .max(127),
            }),
        )
        .min(1)
        .max(MAX_IMAGES),
});

const router = Router();

router.post("/", requireMatchKey, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(422).json({
                error: "invalid_body",
                issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
            });
            return;
        }
        const recorded = await recordKnownChains(parsed.data.images, "chart-index");
        log.info({ received: parsed.data.images.length, recorded }, "Recorded known image chains from the chart index");
        res.json({ received: parsed.data.images.length, recorded });
    })().catch(next);
});

export default router;

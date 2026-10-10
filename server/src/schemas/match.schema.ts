import { z } from "zod";
import { config } from "../config/index.js";

/**
 * `POST /internal/match` request body — `docs/contracts/match-endpoint.md`.
 *
 * The shape of one component is the matcher's own `ComponentInput`: a purl
 * when the SBOM had one, a name always, a version when known. Nothing else is
 * accepted, because nothing else is used — the matcher looks up by purl and
 * range-checks by version, and the response refers back to a component only
 * by its index in this array.
 */

/** The per-request cap. Above it the route answers 413 before parsing. */
export const MATCH_MAX_COMPONENTS: number = config.match.maxComponents;

const componentSchema = z.object({
    purl: z.string().max(4096).nullish(),
    name: z.string().min(1).max(1024),
    version: z.string().max(255).nullish(),
});

export const matchRequestSchema = z.object({
    components: z.array(componentSchema).min(1),
});

export type MatchRequestComponent = z.infer<typeof componentSchema>;

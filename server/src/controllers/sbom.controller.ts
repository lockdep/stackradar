import { resolveImageControlQuietly } from "../services/image-control.service.js";
import type { Request, Response, NextFunction } from "express";
import { sbomService, DuplicateSbomError, assertComponentBudget } from "../services/sbom.service.js";
import { ingestService } from "../services/ingest.service.js";
import { sbomRepository, imageRepository } from "../repositories/index.js";
import { jobService } from "../services/job.service.js";
import { AppError } from "../middleware/error-handler.js";
import { sbomIdParamSchema, sbomDocumentQuerySchema, uploadSbomQuerySchema, checkSbomQuerySchema } from "../schemas/index.js";
import { validateCycloneDx, formatValidationErrors } from "../validators/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { orgRunsImageOfSbom } from "../db/tenancy.js";
import { sbomDocumentFilename } from "../lib/sbom-filename.js";

const log = createLogger("sbom-controller");

export const sbomController = {
    /**
     * Get all SBOMs
     *
     * Deliberately **not** windowed by the plan's `historyDays`: one SBOM per
     * image means this list is the current inventory, not a timeline, and an
     * age cutoff here would hide a still-running image's SBOM — see the
     * history-window note in `config/plans.ts`.
     *
     * @route GET /api/sboms
     * @returns {SbomListResponse[]} 200 - Array of SBOM summaries
     */
    async getAll(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { orgId });
            const sboms = await time("findAllByOrg", sbomService.findAllByOrg(orgId));
            res.json(sboms.map((s) => sbomService.toListResponse(s)));
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get a single SBOM by ID
     * @route GET /api/sboms/:id
     * @param {string} req.params.id - SBOM UUID
     * Ownership is the image's `org_id` (ADR 0006), resolved through
     * `db/tenancy.ts`. Checked *before* the SBOM is loaded — an unauthorised
     * request should not assemble another tenant's component list on its way
     * to a 404.
     *
     * A forbidden SBOM and a missing one are both 404, deliberately: a 403 here
     * would confirm that a given UUID names a real document in someone else's
     * org.
     *
     * @returns {SbomResponse} 200 - Full SBOM details with components
     * @returns {Error} 400 - Invalid SBOM ID format
     * @returns {Error} 404 - SBOM not found, or not on an image this org runs
     */
    async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id } = sbomIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { sbomId: id, orgId });

            const visible = await time("orgRunsImageOfSbom", orgRunsImageOfSbom(orgId, id));
            if (!visible) {
                throw new AppError(404, "SBOM not found");
            }

            const stored = await time("findById", sbomService.findById(id));

            if (!stored) {
                throw new AppError(404, "SBOM not found");
            }

            res.json(sbomService.toResponse(stored));
        } catch (error) {
            next(error);
        }
    },

    /**
     * The CycloneDX document itself — what "saved SBOMs" on the pricing page
     * means. Same tenancy rule and the same 404-not-403 as `getById`.
     *
     * Serves the bytes the scanner uploaded (`raw_json`) verbatim, so what
     * the customer downloads is what was scanned, not our re-serialisation of
     * it. Rows that predate `raw_json` fall back to the reconstructed BOM,
     * which carries the document metadata but no components. Only the
     * current SBOM exists: one per image (`sboms_image_id_unique`), and a
     * `?replace=true` upload deletes its predecessor rather than archiving
     * it, so there is no history to list.
     *
     * `?download=1` adds `Content-Disposition: attachment` with a filename of
     * the form `<image>-<digest8>.cyclonedx.json`; without it the JSON is
     * served inline so a browser tab can render it.
     *
     * @route GET /api/sboms/:id/document
     * @returns {object} 200 - The CycloneDX JSON document
     * @returns {Error} 404 - SBOM not found, or not on an image this org runs
     */
    async getDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id } = sbomIdParamSchema.parse(req.params);
            const { download } = sbomDocumentQuerySchema.parse(req.query);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { sbomId: id, orgId });

            const visible = await time("orgRunsImageOfSbom", orgRunsImageOfSbom(orgId, id));
            if (!visible) {
                throw new AppError(404, "SBOM not found");
            }

            const sbom = await time("findById", sbomRepository.findById(id));
            if (!sbom) {
                throw new AppError(404, "SBOM not found");
            }

            let body: string;
            if (sbom.rawJson) {
                body = JSON.stringify(sbom.rawJson);
            } else {
                const stored = await time("findByIdWithComponents", sbomService.findById(id));
                if (!stored) {
                    throw new AppError(404, "SBOM not found");
                }
                body = sbomService.export(stored);
            }

            if (download) {
                const image = await time("findImage", imageRepository.findById(sbom.imageId));
                const filename = sbomDocumentFilename(image?.repository ?? null, image?.digest ?? null);
                res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            }
            res.type("application/json").send(body);
        } catch (error) {
            next(error);
        }
    },

    /**
     * Upload a CycloneDX SBOM for an **image** — a digest as seen by one
     * cluster ([ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md)).
     *
     * Every upload requires a **cluster-scoped API key**: the SBOM's blast
     * radius is the cluster that uploaded it, and the key is what names that
     * cluster. Workload identity stays optional and, when supplied, links the
     * image to the container running it.
     *
     * `?replace=true` supersedes an existing SBOM for the image instead of
     * 409ing — the recovery path for a bad scanner version or a truncated
     * upload. Safe precisely because the replacement can only affect the
     * cluster whose key made it.
     *
     * @route POST /v1/sboms/upload/cyclonedx?imageDigest={sha256:…}
     * @returns {SbomUploadResponse} 201 - Created SBOM with parsed components
     * @returns {Error} 400 - Invalid query parameters or CycloneDX format
     * @returns {Error} 401 - Authentication required
     * @returns {Error} 403 - No cluster-scoped API key
     * @returns {Error} 409 - This image already has an SBOM (and no `replace=true`)
     */
    async uploadCycloneDx(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const query = uploadSbomQuerySchema.parse(req.query);

            const orgId = req.auth?.orgId;
            if (!orgId) {
                throw new AppError(401, "Authentication required");
            }

            const clusterId = req.auth?.apiKey?.clusterId;
            if (!clusterId) {
                throw new AppError(403, "SBOM upload requires a cluster-scoped API key");
            }

            const wantsWorkloadLink = Boolean(query.namespace);

            const time = createQueryTimer(log, { orgId, clusterId, imageDigest: query.imageDigest });

            // An SPDX document has no `bomFormat` at all, so it would otherwise fail
            // the CycloneDX schema on a pile of missing-required-field errors that
            // never say what the actual problem is. StackRadar ingests CycloneDX only.
            const body = req.body as Record<string, unknown> | undefined;
            if (body && (body.spdxVersion !== undefined || body.SPDXID !== undefined)) {
                throw new AppError(400, "This looks like an SPDX document. StackRadar ingests CycloneDX only — re-run your generator with CycloneDX output (e.g. `syft <target> -o cyclonedx-json`).");
            }

            // Budget before schema: Ajv itself is linear in component count,
            // so an over-budget document must be refused before it (S9).
            if (body) assertComponentBudget(body);

            // Validate against the official CycloneDX 1.6 JSON schema
            const validation = validateCycloneDx(req.body);
            if (!validation.valid) {
                throw new AppError(400, `Invalid CycloneDX format: ${formatValidationErrors(validation.errors)}`);
            }

            const image = await time("resolveImage", ingestService.resolveImage({
                orgId,
                clusterId,
                imageDigest: query.imageDigest,
                imageRef: query.imageRef,
                registry: query.registry,
                repository: query.repository,
            }));

            /*
             * Link before storing. If the SBOM turns out to be a duplicate the
             * link is still the truth — this container really is running this
             * image — and losing it would leave the workload looking unscanned
             * next to an image that has been scanned all along.
             */
            if (wantsWorkloadLink) {
                await time("linkWorkloadContainer", ingestService.linkWorkloadContainer(image.id, {
                    orgId,
                    clusterId,
                    namespace: query.namespace!,
                    workloadName: query.workloadName!,
                    workloadKind: query.workloadKind,
                    containerName: query.containerName!,
                    imageTag: query.imageTag,
                    imageRef: query.imageRef ?? query.imageDigest,
                    namespaceLabels: query.namespaceLabels,
                    workloadLabels: query.workloadLabels,
                }));
            }

            const scannerVersionHeader = req.headers["x-scanner-version"];
            const stored = await time("createFromCycloneDx", sbomService.createFromCycloneDx(req.body, image.id, {
                replace: query.replace,
                scannerVersion: typeof scannerVersionHeader === "string" ? scannerVersionHeader : undefined,
            }));

            /*
             * The upload landing is the proof the scan works again, and it is
             * the ONLY thing that clears a recorded scan failure — the
             * inventory path never does (a restarted scanner reports an empty
             * failure memory, and that absence must not read as recovery).
             * After the store, not before: a rejected document must leave the
             * failure standing.
             */
            await time("clearScanError", imageRepository.clearScanError(image.id));

            // The upload may have brought the `official` fact with its image
            // metadata, and a directly uploaded image has seen no inventory yet.
            await time("resolveImageControl", resolveImageControlQuietly(orgId, [image.id]));

            try {
                const job = await time("queueVulnerabilityScan", jobService.queueVulnerabilityScan(
                    orgId,
                    image.id,
                    stored.sbom.id,
                    "sbom_upload",
                    query.replace ? { replaced: true } : undefined
                ));
                log.info({ jobId: job.id, imageId: image.id, sbomId: stored.sbom.id }, "Queued vulnerability scan after SBOM upload");
            } catch (scanError) {
                log.error({ error: scanError, imageId: image.id }, "Failed to queue vulnerability scan after SBOM upload");
            }

            res.status(201).json(sbomService.toUploadResponse(stored));
        } catch (error) {
            if (error instanceof DuplicateSbomError) {
                next(new AppError(409, "This image already has an SBOM"));
                return;
            }
            next(error);
        }
    },

    /**
     * Delete an SBOM by ID
     * @route DELETE /api/sboms/:id
     * @param {string} req.params.id - SBOM UUID
     * @returns {void} 204 - Successfully deleted
     * @returns {Error} 400 - Invalid SBOM ID format
     * @returns {Error} 404 - SBOM not found
     */
    async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id } = sbomIdParamSchema.parse(req.params);
            const orgId = req.auth!.orgId;
            const time = createQueryTimer(log, { sbomId: id, orgId });

            /*
             * Same ownership rule as the read, and it matters more here: without
             * it this was an unauthenticated-by-tenant destructive write, where
             * knowing a UUID was enough to delete another org's SBOM. Deleting
             * one you *do* run is merely wasteful — the next inventory report
             * re-pulls and re-scans the digest — which is why the image
             * endpoints expose no delete at all.
             */
            const visible = await time("orgRunsImageOfSbom", orgRunsImageOfSbom(orgId, id));
            if (!visible) {
                throw new AppError(404, "SBOM not found");
            }

            const deleted = await time("delete", sbomService.delete(id));

            if (!deleted) {
                throw new AppError(404, "SBOM not found");
            }

            res.status(204).send();
        } catch (error) {
            next(error);
        }
    },

    /**
     * Has **this cluster** scanned this digest.
     *
     * Scoped by the cluster on the caller's API key
     * ([ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md)): the
     * global answer was an oracle — "has anyone on this platform scanned X" —
     * and it was what let one tenant's upload suppress every other tenant's
     * scan of a digest. The scanner needs no change: it asks the same question
     * before every pull, still deduplicates within its own cluster (one image
     * in five namespaces is one pull), and now scans everything its cluster
     * runs exactly once.
     *
     * @route GET /v1/sboms/check?imageDigest=sha256:…
     * @returns {{ exists: boolean }} 200
     * @returns {Error} 403 - No cluster-scoped API key
     */
    async check(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { imageDigest } = checkSbomQuerySchema.parse(req.query);

            if (!req.auth?.orgId) {
                throw new AppError(401, "Authentication required");
            }

            const clusterId = req.auth.apiKey?.clusterId;
            if (!clusterId) {
                throw new AppError(403, "The SBOM check requires a cluster-scoped API key");
            }

            const exists = await sbomRepository.existsByDigest(clusterId, imageDigest);
            res.json({ exists });
        } catch (error) {
            next(error);
        }
    },
};

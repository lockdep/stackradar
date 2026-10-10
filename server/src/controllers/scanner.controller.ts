import { resolveUndecidedInCluster } from "../services/image-control.service.js";
import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { clusterRepository, inventoryRepository, type InventoryReportInput } from "../repositories/index.js";
import {
    inventoryReportSchema,
    INVENTORY_VERSION,
    SUPPORTED_INVENTORY_VERSIONS,
    isSupportedInventoryVersion,
} from "../schemas/index.js";
import { config } from "../config/index.js";
import { verifyAppliedIssues } from "../services/remediation.service.js";
import { cloudHooks } from "../lib/cloud-hooks.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";

const log = createLogger("scanner-controller");

/**
 * The cluster's Kubernetes `gitVersion` from the `X-Kubernetes-Version`
 * heartbeat header. Same trim/cap discipline as `getScannerVersion` in
 * `middleware/auth.ts` (varchar 64); trusted for display and constraint
 * warnings only — auth is the cluster-scoped API key.
 */
function getKubernetesVersion(req: Request): string | undefined {
    const raw = req.headers["x-kubernetes-version"];
    if (!raw || typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

type Warning = { code: string; count?: number };

/**
 * The heartbeat body. `ok` is the contract every agent relies on; the rest is
 * the server's only way to speak to a fleet it cannot push to — "upgrade",
 * "this version is deprecated", "maintenance at 02:00" — and is omitted when
 * there is nothing to say, so the common response stays `{ok:true}`.
 */
export function heartbeatResponse(): { ok: true; minScannerVersion?: string; message?: string } {
    return {
        ok: true,
        ...(config.scanner.minVersion ? { minScannerVersion: config.scanner.minVersion } : {}),
        ...(config.scanner.message ? { message: config.scanner.message } : {}),
    };
}

/*
 * Version first, and with its own message. An older scanner sends
 * a shape that fails the v3 schema on a pile of missing-field
 * errors that never say what the actual problem is.
 * The scanner logs this once per interval and keeps uploading
 * SBOMs — inventory is a progress signal, and losing it must never
 * stop the thing that finds vulnerabilities.
 */
function assertInventoryVersion(req: Request): void {
    const version = (req.body as { version?: unknown } | undefined)?.version;
    if (!isSupportedInventoryVersion(version)) {
        const running = req.headers["x-scanner-version"];
        throw new AppError(
            400,
            `This server accepts inventory payload version${SUPPORTED_INVENTORY_VERSIONS.length > 1 ? "s" : ""} ${SUPPORTED_INVENTORY_VERSIONS.join(", ")}; received ${JSON.stringify(version) ?? "none"}. ` +
            "Upgrade the stackradar-scanner chart" +
            (typeof running === "string" ? ` (currently running ${running})` : "") +
            ". SBOM upload is unaffected."
        );
    }
}

/*
 * The empty-report hazard. A full set replacement with no
 * namespaces deletes the cluster's entire inventory, and a broken
 * informer that syncs to zero pods produces exactly that body.
 * Both guards reject **without touching stored rows**: losing a
 * real deletion for one interval is cheap, and a genuinely empty
 * cluster is represented by no report at all, ageing out via
 * `lastSeenAt` rather than being truncated in one step.
 */
function assertReplacementIsSafe(report: {
    informerSynced: boolean;
    namespaces: unknown[];
}): void {
    if (!report.informerSynced) {
        throw new AppError(
            400,
            "Inventory rejected: informerSynced is false. Report only after the informer has completed its initial sync."
        );
    }
    if (report.namespaces.length === 0) {
        throw new AppError(
            400,
            "Inventory rejected: a report with zero namespaces would delete the cluster's entire inventory. Send no report instead."
        );
    }
}

/*
 * Warnings make a degraded-but-working agent visible as data rather
 * than as a log line. Twelve workloads with no resolvable `kind`
 * means twelve remediation commands will be wrong, and that belongs
 * in the UI as a coverage caveat.
 */
function collectInventoryWarnings(report: {
    namespaces: { labels: unknown; workloads: { kind: string | null }[] }[];
    ownerMetadataCollected: boolean;
}): Warning[] {
    const warnings: Warning[] = [];
    const kindUnresolved = report.namespaces.reduce(
        (n, ns) => n + ns.workloads.filter((w) => w.kind === null).length,
        0
    );
    if (kindUnresolved > 0) warnings.push({ code: "kind_unresolved", count: kindUnresolved });

    const labelsNotCollected = report.namespaces.filter((ns) => ns.labels === null).length;
    if (labelsNotCollected > 0) {
        warnings.push({ code: "namespace_labels_not_collected", count: labelsNotCollected });
    }

    /*
     * No count, because the number is not "how many workloads are
     * affected" — it is "we do not know which ones are". The agent
     * could not read any controller, so every unattributed workload in
     * this report might be chart-managed, and the UI has to say that
     * rather than assert an unmanaged count it cannot support.
     *
     * Persisted as well as returned: the scanner logs the warning, but
     * the browser is what has to render the caveat, and it never sees
     * this response.
     */
    if (!report.ownerMetadataCollected) {
        warnings.push({ code: "owner_metadata_not_collected" });
    }
    return warnings;
}

export const scannerController = {
    async heartbeat(req: Request, res: Response, next: NextFunction) {
        try {
            if (!req.auth?.apiKey?.clusterId) {
                throw new AppError(403, "Heartbeat requires a cluster-scoped API key");
            }
            const sentClusterId = req.headers["x-cluster-id"];
            if (sentClusterId && sentClusterId !== req.auth.apiKey.clusterId) {
                throw new AppError(403, "STACKRADAR_CLUSTER_ID does not match the cluster ID associated with this API key");
            }
            // Written here rather than in the per-request middleware: the
            // version rides the heartbeat only, and an absent header leaves
            // the stored value unchanged — an older scanner must not erase
            // knowledge a newer one recorded.
            const kubernetesVersion = getKubernetesVersion(req);
            if (kubernetesVersion) {
                await clusterRepository.recordKubernetesVersion(
                    req.auth.apiKey.clusterId,
                    kubernetesVersion
                );
            }
            res.json(heartbeatResponse());
        } catch (error) {
            next(error);
        }
    },

    /**
     * Record everything the scanner's informer can currently see.
     *
     * Under [ADR 0004](../../../docs/adr/0004-image-as-the-unit-of-identity.md)
     * this is the **primary write path** for `namespaces`, `workloads`,
     * `workload_containers`, `helm_releases` and `gitops_applications` — not a
     * progress hint feeding a side table. The wire format is
     * [contracts/inventory-v3.md](../../../docs/contracts/inventory-v3.md).
     *
     * Separate from `/v1/heartbeat` rather than a body on it: the heartbeat is
     * a liveness signal on a fixed 5-minute timer and is what `/healthz`
     * reports on, and a rejected 6 MB inventory body must not read as a dead
     * scanner.
     *
     * @route POST /v1/inventory
     */
    async reportInventory(req: Request, res: Response, next: NextFunction) {
        try {
            const clusterId = req.auth?.apiKey?.clusterId;
            if (!clusterId) {
                throw new AppError(403, "Inventory reporting requires a cluster-scoped API key");
            }
            const orgId = req.auth!.orgId;

            assertInventoryVersion(req);
            const report = inventoryReportSchema.parse(req.body);
            assertReplacementIsSafe(report);

            const input: InventoryReportInput = {
                releases: report.releases,
                applications: report.applications,
                namespaces: report.namespaces,
                scanFailures: report.scanFailures,
            };

            const time = createQueryTimer(log, { orgId, clusterId });
            const accepted = await time(
                "replaceInventory",
                inventoryRepository.replaceForCluster(orgId, clusterId, input)
            );

            const warnings = collectInventoryWarnings(report);
            await clusterRepository.recordOwnerMetadataCollected(
                clusterId,
                report.ownerMetadataCollected
            );

            /*
             * The remediation verify loop closes here: the report is a full
             * set replacement, so this is the first moment "the vulnerable
             * digest is no longer running" is a fact rather than a hope, and
             * an applied issue can flip to verified with no user input.
             * `verifyAppliedIssues` is best-effort by contract — inventory
             * ingest must never fail because bookkeeping did.
             */
            const verified = await time("verifyAppliedIssues", verifyAppliedIssues(clusterId));
            if (verified > 0) {
                log.info({ orgId, clusterId, verified }, "Verified applied issues");
            }

            // Who controls the images this report introduced (`images.control`).
            // Best-effort like the verify loop: a label never fails a report.
            await time("resolveImageControl", resolveUndecidedInCluster(orgId, clusterId));

            // The first inventory from a self-signed-up org is the "connected
            // a cluster" moment: the funnel event, the founder alert and (off
            // an ad click) the conversion. Not awaited: one indexed read per
            // report, network calls only for the org that still owes them,
            // and never a reason for the report to fail.
            const scannerVersion = req.headers["x-scanner-version"];
            cloudHooks.onClusterReported(orgId, {
                clusterId,
                accepted: {
                    namespaces: accepted.namespaces,
                    workloads: accepted.workloads,
                    containers: accepted.containers,
                },
                scannerVersion: typeof scannerVersion === "string" ? scannerVersion : null,
            });

            log.info(
                { orgId, clusterId, ...accepted, warnings: warnings.length, reportedAt: report.reportedAt },
                "Recorded cluster inventory"
            );

            res.json({
                accepted: {
                    namespaces: accepted.namespaces,
                    workloads: accepted.workloads,
                    containers: accepted.containers,
                    releases: accepted.releases,
                    applications: accepted.applications,
                },
                warnings,
            });
        } catch (error) {
            next(error);
        }
    },
};

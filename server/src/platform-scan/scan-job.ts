/**
 * The `platform_scan` worker job: pull one public candidate digest, run the pinned syft binary, and
 * ingest the SBOM **in-process** through the existing SBOM service under the
 * platform org and cluster.
 *
 * In-process is the point: the ingest never touches `/v1`, so no credential
 * exists that could do this from outside — the guard in
 * `cluster.repository.ts` makes minting one impossible. The rows written are
 * ordinary `images` / `sboms` / `components` rows; the existing
 * `vulnerability_scan` job then matches them exactly as it matches any
 * tenant upload. Sharing them is safe for the reason ADR 0006 states: it
 * requires trusting no tenant.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chartObservationRepository } from "../repositories/chart-observation.repository.js";
import { jobRepository } from "../repositories/job.repository.js";
import { ensurePlatform } from "../services/platform.service.js";
import { ingestService } from "../services/ingest.service.js";
import { sbomService } from "../services/sbom.service.js";
import { validateCycloneDx, formatValidationErrors } from "../validators/index.js";
import { isPublicRegistry } from "../lib/public-registries.js";
import { IMAGE_TOO_LARGE, JobFailure } from "../lib/job-failure.js";
import { createLogger } from "../lib/logger.js";
import { config } from "./config.js";
import { imageLayerBytes } from "./image-size.js";

const execFileAsync = promisify(execFile);

const log = createLogger("platform-scan");

export interface PlatformScanParams {
    digest: string;
    registry: string;
    repository: string;
}

function parseParams(params: Record<string, unknown> | null): PlatformScanParams {
    const str = (k: string): string => {
        const v = params?.[k];
        if (typeof v !== "string" || v.length === 0) {
            throw new Error(`platform_scan job params missing "${k}"`);
        }
        return v;
    };
    return { digest: str("digest"), registry: str("registry"), repository: str("repository") };
}

const PLATFORM_SCAN_SCOPE = "deep-squashed";

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);

/**
 * Run syft in a private `TMPDIR` under the worker's, removed when the run
 * ends. stereoscope unpacks the pulled layers there; a run that dies (the
 * worker OOM-killed, syft SIGKILLed on timeout) would otherwise leave them
 * in the pod's emptyDir until the pod itself goes away. syft also inherits
 * the worker's environment, which is how `GOMEMLIMIT` on the Deployment
 * reaches it.
 */
async function runSyft(ref: string): Promise<unknown> {
    const runDir = await mkdtemp(join(tmpdir(), "platform-scan-"));

    const attempt = async (withPlatform: boolean) => {
        const args = [
            `registry:${ref}`,
            // Same scope as the in-cluster scanner (component tier plan,
            // item 5): the squashed package set, with every layer a package
            // existed in — without it an apk/rpm package's layer is the
            // package database's, and base-image attribution is wrong.
            "--scope",
            PLATFORM_SCAN_SCOPE,
            "-o",
            "cyclonedx-json",
            "-q",
            ...(withPlatform ? ["--platform", config.platform] : []),
        ];
        const { stdout } = await execFileAsync(config.syftBin, args, {
            timeout: config.scanTimeoutMs,
            maxBuffer: config.maxSbomBytes,
            killSignal: "SIGKILL",
            env: { ...process.env, TMPDIR: runDir },
        });
        return JSON.parse(stdout) as unknown;
    };

    try {
        try {
            return await attempt(true);
        } catch (err) {
            // A single-manifest digest has no platform to select; retry without.
            const message = err instanceof Error ? err.message : String(err);
            const stderr = ((err as { stderr?: string }).stderr ?? "").toString();
            if (/platform|manifest list|index/i.test(stderr + message)) {
                return await attempt(false);
            }
            throw err;
        }
    } finally {
        await rm(runDir, { recursive: true, force: true }).catch((err: unknown) => {
            log.warn(
                { runDir, error: err instanceof Error ? err.message : String(err) },
                "Could not remove syft run directory",
            );
        });
    }
}

export async function runPlatformScanJob(rawParams: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const params = parseParams(rawParams);

    // Defence in depth — the render job only queues allowlisted registries,
    // but this job must hold the line on its own inputs too.
    if (!isPublicRegistry(params.registry)) {
        throw new Error(`registry ${params.registry} is not on the public allowlist`);
    }

    // Size first, pull second: an image over the ceiling is refused with a
    // reason and never pulled. Unmeasured (a registry quirk, a 429) pulls
    // anyway — syft's own error is the authoritative one.
    const size = await imageLayerBytes(params, config.platform, {
        timeoutMs: config.manifestTimeoutMs,
        userAgent: config.userAgent,
    });
    if (size.ok && size.bytes > config.maxImageBytes) {
        throw new JobFailure(
            IMAGE_TOO_LARGE,
            `image is ${mib(size.bytes)} MiB compressed across ${size.layers} layers, over the ` +
                `${mib(config.maxImageBytes)} MiB ceiling (PLATFORM_SCAN_MAX_IMAGE_BYTES); not pulled`,
        );
    }
    if (!size.ok) {
        log.warn(
            {
                digest: params.digest,
                repository: params.repository,
                reason: size.reason,
                rateLimited: size.rateLimited,
            },
            "Could not size image before the pull; pulling anyway",
        );
    }

    const ref = `${params.registry}/${params.repository}@${params.digest}`;
    const doc = await runSyft(ref);

    const validation = validateCycloneDx(doc);
    if (!validation.valid) {
        throw new Error(`syft produced an invalid CycloneDX document: ${formatValidationErrors(validation.errors)}`);
    }

    const { orgId, clusterId } = await ensurePlatform();
    const image = await ingestService.resolveImage({
        orgId,
        clusterId,
        imageDigest: params.digest,
        registry: params.registry,
        repository: params.repository,
    });

    // `replace: true`: a re-scan (newer syft, recovered failure) supersedes —
    // the same recovery semantics `?replace=true` gives a tenant scanner.
    const stored = await sbomService.createFromCycloneDx(doc, image.id, {
        replace: true,
        // The scope rides in the provenance string: item 6 only trusts an
        // OS package's layer from a deep-squashed SBOM (`layerAttributionTrusted`).
        scannerVersion: `platform/${config.platform}@${PLATFORM_SCAN_SCOPE}`,
    });

    // The ordinary matching pass, exactly as a tenant upload queues it.
    const scanJob = await jobRepository.create({
        orgId,
        imageId: image.id,
        sbomId: stored.sbom.id,
        type: "vulnerability_scan",
        title: `${params.repository}@${params.digest.slice(0, 19)}: Vulnerability Scan`,
        triggeredBy: "system",
        priority: 4,
    });

    const imageBytes = size.ok ? size.bytes : null;
    log.info(
        { digest: params.digest, repository: params.repository, imageId: image.id, imageBytes },
        "Platform-scanned candidate digest",
    );
    return {
        imageId: image.id,
        sbomId: stored.sbom.id,
        components: stored.components.length,
        platform: config.platform,
        imageBytes,
        matchJobId: scanJob.id,
    };
}

/**
 * The nightly sweep behind render-time queueing: any resolved observation
 * digest still missing a platform SBOM (a crashed job, a render from before
 * the scanner existed) gets a scan queued, bounded per run.
 */
export async function enqueueMissingPlatformScans(): Promise<number> {
    const { orgId, clusterId } = await ensurePlatform();
    const missing = await chartObservationRepository.unscannedDigests(clusterId, config.maxScansPerSweep);
    if (missing.length === 0) return 0;

    // A digest with an open job — typically one the render pass queued
    // minutes ago — is covered, not missing. One refused for size stays
    // refused until its failed row ages out of the jobs table; re-queueing
    // it nightly would spend a sweep slot and a manifest read on a known
    // answer.
    const [openDigests, refusedDigests] = await Promise.all([
        jobRepository.openParamKeys("platform_scan", (p) => p["digest"]),
        jobRepository.failedParamKeys("platform_scan", IMAGE_TOO_LARGE, (p) => p["digest"]),
    ]);

    let queued = 0;
    for (const row of missing) {
        if (!isPublicRegistry(row.registry)) continue;
        if (openDigests.has(row.digest) || refusedDigests.has(row.digest)) continue;
        await jobRepository.create({
            orgId,
            type: "platform_scan",
            title: `${row.repository}@${row.digest.slice(0, 19)}: Platform Scan`,
            triggeredBy: "system",
            priority: 2,
            params: { digest: row.digest, registry: row.registry, repository: row.repository },
        });
        queued += 1;
    }
    if (queued > 0) log.info({ queued }, "Queued missing platform scans");
    return queued;
}

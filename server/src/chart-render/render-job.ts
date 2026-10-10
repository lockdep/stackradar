/**
 * The `chart_render` worker job —
 * [measuring-candidate-charts.md](../../../docs/proposals/measuring-candidate-charts.md)
 * phase 2: download the candidate tarball, render it with default values,
 * extract the images its PodSpecs deploy, resolve each tag to a digest, and
 * store the lot as provenance-free observations.
 *
 * Failure shape: any cap or error records the version as `render_failed` with
 * its reason and the job **completes** — the release keeps its unmeasured
 * card, and the `chart_renders` row keeps the nightly selection from retrying
 * a deterministic failure forever. A ref that fails to *resolve* is smaller
 * than that: a null-digest observation with a reason, which measures nothing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartObservationRepository } from "../repositories/chart-observation.repository.js";
import { jobRepository } from "../repositories/job.repository.js";
import { IMAGE_TOO_LARGE } from "../lib/job-failure.js";
import { ensurePlatform } from "../services/platform.service.js";
import { parseImageRef } from "../utils/image-ref.js";
import {
    isPublicRegistry,
    normalizeRegistry,
    pairRepository,
} from "../lib/public-registries.js";
import { createLogger } from "../lib/logger.js";
import { config } from "./config.js";
import { downloadTarball, type TarballResult } from "./tarball.js";
import { renderChart, helmVersion, type RenderResult } from "./helm.js";
import { extractPodImages } from "./manifest-images.js";
import { renderKubeVersion } from "./kube-version.js";
import { resolveDigest, type DigestResult } from "./registry.js";

const log = createLogger("chart-render");

export interface ChartRenderParams {
    repoUrl: string;
    chartName: string;
    chartVersion: string;
    tarballUrl: string;
    kubeRange: string | null;
}

/** Injectable edges — everything that leaves the process — for tests. */
export interface ChartRenderDeps {
    download: typeof downloadTarball;
    render: typeof renderChart;
    resolve: (ref: { registry: string; repository: string; tag: string }) => Promise<DigestResult>;
}

const defaultDeps: ChartRenderDeps = {
    download: downloadTarball,
    render: renderChart,
    resolve: (ref) =>
        resolveDigest(ref, { timeoutMs: config.requestTimeoutMs, userAgent: config.userAgent }),
};

function parseParams(params: Record<string, unknown> | null): ChartRenderParams {
    const str = (k: string): string => {
        const v = params?.[k];
        if (typeof v !== "string" || v.length === 0) {
            throw new Error(`chart_render job params missing "${k}"`);
        }
        return v;
    };
    const kubeRange = params?.["kubeRange"];
    return {
        repoUrl: str("repoUrl"),
        chartName: str("chartName"),
        chartVersion: str("chartVersion"),
        tarballUrl: str("tarballUrl"),
        kubeRange: typeof kubeRange === "string" ? kubeRange : null,
    };
}

export async function runChartRenderJob(
    rawParams: Record<string, unknown> | null,
    deps: ChartRenderDeps = defaultDeps
): Promise<Record<string, unknown>> {
    const params = parseParams(rawParams);
    const identity = {
        repoUrl: params.repoUrl,
        chartName: params.chartName,
        chartVersion: params.chartVersion,
    };

    const failed = async (reason: string): Promise<Record<string, unknown>> => {
        await chartObservationRepository.recordRender({
            ...identity,
            status: "render_failed",
            failureReason: reason,
            helmVersion: await helmVersion(config.helmBin),
            kubeVersion: null,
            renderedAt: new Date(),
        });
        log.warn({ ...identity, reason }, "Chart render failed");
        return { status: "render_failed", reason };
    };

    const workDir = await mkdtemp(join(tmpdir(), "chart-render-"));
    try {
        const tarball: TarballResult = await deps.download(params.tarballUrl, {
            destDir: workDir,
            maxBytes: config.maxTarballBytes,
            timeoutMs: config.requestTimeoutMs,
            userAgent: config.userAgent,
        });
        if (!tarball.ok) return await failed(tarball.reason);

        const kubeVersion = renderKubeVersion(params.kubeRange);
        const rendered: RenderResult = await deps.render({
            helmBin: config.helmBin,
            tarballPath: tarball.path,
            kubeVersion,
            timeoutMs: config.renderTimeoutMs,
            maxOutputBytes: config.maxOutputBytes,
        });
        if (!rendered.ok) return await failed(rendered.reason);

        const refs = extractPodImages(rendered.manifests);

        let resolved = 0;
        let unresolved = 0;
        const resolvedDigests = new Map<string, { registry: string; repository: string }>();

        for (const imageRef of refs) {
            const parsed = parseImageRef(imageRef);
            const registry = normalizeRegistry(parsed.registry);
            // Canonical repository — `nginx` on Docker Hub is `library/nginx` —
            // so observation rows pair with tenant images by one rule.
            const repository = pairRepository(registry, parsed.repository);
            // Kubernetes pull semantics: a ref with neither tag nor digest is
            // `:latest`. That is the runtime's rule, not an inference of ours.
            const tag = parsed.tag ?? (parsed.digest ? null : "latest");

            let digest: string | null = null;
            let resolutionError: string | null = null;
            if (parsed.digest) {
                digest = parsed.digest;
            } else if (!isPublicRegistry(registry)) {
                resolutionError = `registry ${registry} is not on the public allowlist`;
            } else {
                const result = await deps.resolve({ registry, repository, tag: tag! });
                if (result.ok) digest = result.digest;
                else resolutionError = result.reason;
            }

            if (digest && isPublicRegistry(registry)) {
                resolved += 1;
                if (!resolvedDigests.has(digest)) resolvedDigests.set(digest, { registry, repository });
            } else {
                unresolved += 1;
            }

            await chartObservationRepository.upsertObservation({
                ...identity,
                imageRef,
                registry,
                repository,
                tag,
                digest,
                resolutionError,
            });
        }

        await chartObservationRepository.recordRender({
            ...identity,
            status: "rendered",
            failureReason: null,
            helmVersion: await helmVersion(config.helmBin),
            kubeVersion,
            renderedAt: new Date(),
        });

        const scansQueued = await queuePlatformScans(resolvedDigests);

        log.info(
            { ...identity, images: refs.length, resolved, unresolved, scansQueued },
            "Rendered candidate chart"
        );
        return { status: "rendered", images: refs.length, resolved, unresolved, scansQueued };
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
}

/**
 * Queue a `platform_scan` for each resolved digest the platform cluster does
 * not hold an SBOM for and no open job already covers. Params carry the
 * digest and its public pull coordinates — nothing else.
 */
async function queuePlatformScans(
    digests: Map<string, { registry: string; repository: string }>
): Promise<number> {
    if (digests.size === 0) return 0;
    const { orgId, clusterId } = await ensurePlatform();

    const scanned = await chartObservationRepository.platformImagesForDigests(clusterId, [
        ...digests.keys(),
    ]);

    // Open = already queued or running; refused = failed for size, which a
    // re-queue would only repeat (platform-scan/image-size.ts).
    const [openDigests, refusedDigests] = await Promise.all([
        jobRepository.openParamKeys("platform_scan", (p) => p["digest"]),
        jobRepository.failedParamKeys("platform_scan", IMAGE_TOO_LARGE, (p) => p["digest"]),
    ]);

    let queued = 0;
    for (const [digest, coords] of digests) {
        if (scanned.has(digest) || openDigests.has(digest) || refusedDigests.has(digest)) continue;
        await jobRepository.create({
            orgId,
            type: "platform_scan",
            title: `${coords.repository}@${digest.slice(0, 19)}: Platform Scan`,
            triggeredBy: "system",
            priority: 2,
            params: { digest, registry: coords.registry, repository: coords.repository },
        });
        queued += 1;
    }
    return queued;
}

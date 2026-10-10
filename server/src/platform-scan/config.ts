/**
 * Platform-scan configuration —
 * [measuring-candidate-charts.md](../../../docs/proposals/measuring-candidate-charts.md)
 * phase 3. The scanner pulls public candidate digests anonymously and runs
 * the pinned syft binary; the caps bound what one hostile or enormous image
 * can cost.
 */

import { envPositiveNumber, envString } from "../lib/env.js";

export interface PlatformScanConfig {
    /** Path to the pinned syft binary (checksum-verified in the worker image). */
    syftBin: string;
    /** Wall-clock ceiling on one pull-plus-syft run. */
    scanTimeoutMs: number;
    /** Ceiling on the produced CycloneDX document. */
    maxSbomBytes: number;
    /**
     * Ceiling on the image itself — compressed layer bytes the manifest
     * declares — checked before the pull (image-size.ts). syft shares the
     * worker's cgroup, and an image over this is refused with a reason
     * rather than pulled and OOM-killed mid-batch (2026-09-10).
     */
    maxImageBytes: number;
    /** Wall-clock ceiling on one manifest request in that pre-flight. */
    manifestTimeoutMs: number;
    /** User-Agent on the registry requests the pre-flight makes. */
    userAgent: string;
    /**
     * The single platform each digest is scanned for. One architecture per
     * digest, recorded on the job result — the delta is computed between two
     * platform-scanned digests, so the comparison stays internally consistent
     * whatever the customer's own architecture is.
     */
    platform: string;
    /** Digests swept per nightly run when render-time queueing missed any. */
    maxScansPerSweep: number;
}

export function loadConfig(): PlatformScanConfig {
    return {
        syftBin: envString("SYFT_BIN", "syft"),
        scanTimeoutMs: envPositiveNumber("PLATFORM_SCAN_TIMEOUT_MS", 10 * 60 * 1000),
        maxSbomBytes: envPositiveNumber("PLATFORM_SCAN_MAX_SBOM_BYTES", 50 * 1024 * 1024),
        maxImageBytes: envPositiveNumber("PLATFORM_SCAN_MAX_IMAGE_BYTES", 1024 * 1024 * 1024),
        manifestTimeoutMs: envPositiveNumber("PLATFORM_SCAN_MANIFEST_TIMEOUT_MS", 30 * 1000),
        userAgent: "sbom-tracker-platform-scan/1.0",
        platform: envString("PLATFORM_SCAN_PLATFORM", "linux/amd64"),
        maxScansPerSweep: envPositiveNumber("PLATFORM_SCAN_MAX_PER_SWEEP", 50),
    };
}

export const config = loadConfig();

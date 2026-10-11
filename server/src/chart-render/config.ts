/**
 * Chart-render configuration.
 *
 * Every cap here is load-bearing: template rendering executes no arbitrary
 * code (Helm disables `env`/`expandenv`), so resource exhaustion is the whole
 * attack surface of a hostile chart, and the caps are the answer. A chart
 * that exceeds any of them is recorded as `render_failed` with the reason —
 * never silently partial.
 */

import { envPositiveNumber, envString } from "../lib/env.js";
import { SERVER_VERSION } from "../lib/server-version.js";

export interface ChartRenderConfig {
    /** Path to the pinned helm binary (checksum-verified in the worker image). */
    helmBin: string;
    /** Refuse to download a chart tarball larger than this. */
    maxTarballBytes: number;
    /** Wall-clock ceiling on one `helm template` invocation. */
    renderTimeoutMs: number;
    /** Ceiling on rendered manifest output. kube-prometheus-stack is ~3 MB. */
    maxOutputBytes: number;
    /** Renders enqueued per nightly run; the queue drains across runs. */
    maxRendersPerRun: number;
    /** Timeout for tarball downloads and registry digest resolution. */
    requestTimeoutMs: number;
    userAgent: string;
}

export function loadConfig(): ChartRenderConfig {
    return {
        helmBin: envString("HELM_BIN", "helm"),
        maxTarballBytes: envPositiveNumber("CHART_RENDER_MAX_TARBALL_BYTES", 20 * 1024 * 1024),
        renderTimeoutMs: envPositiveNumber("CHART_RENDER_TIMEOUT_MS", 60_000),
        maxOutputBytes: envPositiveNumber("CHART_RENDER_MAX_OUTPUT_BYTES", 50 * 1024 * 1024),
        maxRendersPerRun: envPositiveNumber("CHART_RENDER_MAX_PER_RUN", 25),
        requestTimeoutMs: envPositiveNumber("CHART_RENDER_REQUEST_TIMEOUT_MS", 60_000),
        userAgent: `stackradar-chart-render/${SERVER_VERSION}`,
    };
}

export const config = loadConfig();

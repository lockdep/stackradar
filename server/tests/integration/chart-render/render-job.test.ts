/**
 * The chart_render job end to end — measuring-candidate-charts.md phase 2 —
 * against a real chart tarball rendered by the real helm binary, with the
 * registry edge stubbed (tests make no network calls).
 *
 * The failure-shape assertions matter most: a failed download is a
 * `render_failed` row with its reason and nothing else — no observations, no
 * scans queued — and the release keeps its unmeasured card.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import type { ChartRenderDeps } from "../../../src/chart-render/render-job.js";

const execFileAsync = promisify(execFile);

const REPO_URL = "https://charts.example.com";
const DIGEST = "sha256:" + "a".repeat(64);

let helmAvailable = false;
try {
    await execFileAsync("helm", ["version", "--template={{.Version}}"], { timeout: 10_000 });
    helmAvailable = true;
} catch {
    helmAvailable = false;
}

/** A minimal but real chart: one Deployment, one private-registry sidecar. */
async function buildChartTarball(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "chart-fixture-"));
    const chartDir = join(dir, "testchart");
    await mkdir(join(chartDir, "templates"), { recursive: true });

    await writeFile(
        join(chartDir, "Chart.yaml"),
        ["apiVersion: v2", "name: testchart", "version: 1.1.0", "appVersion: 2.0.0"].join("\n")
    );
    await writeFile(
        join(chartDir, "values.yaml"),
        ["image: quay.io/acme/app:2.0.0", "sidecarImage: registry.internal.corp/acme/sidecar:1.0"].join("\n")
    );
    await writeFile(
        join(chartDir, "templates", "deployment.yaml"),
        `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
spec:
  template:
    spec:
      containers:
        - name: app
          image: {{ .Values.image }}
        - name: sidecar
          image: {{ .Values.sidecarImage }}
`
    );

    const tarball = join(dir, "testchart-1.1.0.tgz");
    // COPYFILE_DISABLE: macOS bsdtar otherwise adds AppleDouble entries
    // (`._testchart`), which helm rejects as content outside the base dir.
    await execFileAsync("tar", ["-czf", tarball, "-C", dir, "testchart"], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return tarball;
}

async function renderJob() {
    return import("../../../src/chart-render/render-job.js");
}

describe.skipIf(!helmAvailable)("runChartRenderJob (requires the helm binary)", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("renders, extracts, resolves public refs, refuses private ones, and queues scans", async () => {
        const db = getTestDb();
        const tarball = await buildChartTarball();

        const { runChartRenderJob } = await renderJob();
        const { downloadTarball } = await import("../../../src/chart-render/tarball.js");
        const { renderChart } = await import("../../../src/chart-render/helm.js");

        const deps: ChartRenderDeps = {
            download: downloadTarball,
            render: renderChart,
            resolve: async (ref) => {
                expect(ref).toEqual({ registry: "quay.io", repository: "acme/app", tag: "2.0.0" });
                return { ok: true, digest: DIGEST };
            },
        };

        const result = await runChartRenderJob(
            {
                repoUrl: REPO_URL,
                chartName: "testchart",
                chartVersion: "1.1.0",
                tarballUrl: pathToFileURL(tarball).toString(),
                kubeRange: ">=1.21.0-0",
            },
            deps
        );

        expect(result).toMatchObject({ status: "rendered", images: 2, resolved: 1, unresolved: 1 });

        const [render] = await db
            .select()
            .from(schema.chartRenders)
            .where(eq(schema.chartRenders.chartName, "testchart"));
        expect(render).toMatchObject({
            status: "rendered",
            chartVersion: "1.1.0",
            kubeVersion: "1.21.0",
        });
        expect(render!.helmVersion).toMatch(/^v?\d+\.\d+/);

        const observations = await db
            .select()
            .from(schema.chartImageObservations)
            .where(eq(schema.chartImageObservations.chartName, "testchart"));
        expect(observations).toHaveLength(2);

        const app = observations.find((o) => o.repository === "acme/app");
        expect(app).toMatchObject({
            registry: "quay.io",
            tag: "2.0.0",
            digest: DIGEST,
            resolutionError: null,
        });

        // The private-registry sidecar is stored unresolved with its reason —
        // it measures nothing, and the platform never contacts that host.
        const sidecar = observations.find((o) => o.repository === "acme/sidecar");
        expect(sidecar!.digest).toBeNull();
        expect(sidecar!.resolutionError).toMatch(/allowlist/);

        // One platform_scan queued, for the resolved digest only, under the
        // platform org, carrying nothing but public pull coordinates.
        const scans = await db
            .select()
            .from(schema.jobs)
            .where(eq(schema.jobs.type, "platform_scan"));
        expect(scans).toHaveLength(1);
        expect(scans[0]!.params).toEqual({
            digest: DIGEST,
            registry: "quay.io",
            repository: "acme/app",
        });

        // Re-running upserts rather than duplicating, and queues no second scan.
        const again = await runChartRenderJob(
            {
                repoUrl: REPO_URL,
                chartName: "testchart",
                chartVersion: "1.1.0",
                tarballUrl: pathToFileURL(tarball).toString(),
                kubeRange: null,
            },
            deps
        );
        expect(again).toMatchObject({ status: "rendered", scansQueued: 0 });
        expect(
            await db
                .select()
                .from(schema.chartImageObservations)
                .where(eq(schema.chartImageObservations.chartName, "testchart"))
        ).toHaveLength(2);
    });

    it("records a failed download as render_failed with the reason, and nothing else", async () => {
        const db = getTestDb();
        const { runChartRenderJob } = await renderJob();
        const { downloadTarball } = await import("../../../src/chart-render/tarball.js");
        const { renderChart } = await import("../../../src/chart-render/helm.js");

        const result = await runChartRenderJob(
            {
                repoUrl: REPO_URL,
                chartName: "testchart",
                chartVersion: "9.9.9",
                tarballUrl: pathToFileURL(join(tmpdir(), "does-not-exist.tgz")).toString(),
                kubeRange: null,
            },
            {
                download: downloadTarball,
                render: renderChart,
                resolve: async () => {
                    throw new Error("must not be called");
                },
            }
        );

        expect(result["status"]).toBe("render_failed");

        const [render] = await db
            .select()
            .from(schema.chartRenders)
            .where(eq(schema.chartRenders.chartVersion, "9.9.9"));
        expect(render?.status).toBe("render_failed");
        expect(render?.failureReason).toBeTruthy();

        expect(await db.select().from(schema.chartImageObservations)).toHaveLength(0);
        expect(
            await db.select().from(schema.jobs).where(eq(schema.jobs.type, "platform_scan"))
        ).toHaveLength(0);
    });
});

describe("downloadTarball caps", () => {
    it("refuses a tarball over the byte ceiling", async () => {
        const dir = await mkdtemp(join(tmpdir(), "tarball-cap-"));
        const big = join(dir, "big.tgz");
        await writeFile(big, Buffer.alloc(4096));

        const { downloadTarball } = await import("../../../src/chart-render/tarball.js");
        const result = await downloadTarball(pathToFileURL(big).toString(), {
            destDir: dir,
            maxBytes: 1024,
            timeoutMs: 5_000,
            userAgent: "test",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/ceiling|bytes/);
    });

    it("refuses non-http(s), non-file URLs", async () => {
        const dir = await mkdtemp(join(tmpdir(), "tarball-scheme-"));
        const { downloadTarball } = await import("../../../src/chart-render/tarball.js");
        const result = await downloadTarball("oci://ghcr.io/acme/chart:1.0.0", {
            destDir: dir,
            maxBytes: 1024,
            timeoutMs: 5_000,
            userAgent: "test",
        });
        expect(result.ok).toBe(false);
    });
});

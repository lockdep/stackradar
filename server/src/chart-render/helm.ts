/**
 * The one subprocess this worker runs: the real `helm` binary, pinned by
 * version and checksum in the worker image.
 *
 * A pure-JS renderer was considered and rejected: charts are Go templates plus Sprig plus Helm's own functions, and a
 * reimplementation would diverge exactly on the charts complex enough to
 * matter. Template rendering executes no arbitrary code (Helm disables
 * `env`/`expandenv`), so the caps — timeout and output size, both enforced
 * here — are the entire safety story.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RenderResult = { ok: true; manifests: string } | { ok: false; reason: string };

/**
 * `helm template` over a local tarball, default values only. Hooks are
 * rendered (helm includes them by default; their images run at install);
 * test manifests are filtered later by the extraction walk.
 */
export async function renderChart(opts: {
    helmBin: string;
    tarballPath: string;
    kubeVersion: string | null;
    timeoutMs: number;
    maxOutputBytes: number;
}): Promise<RenderResult> {
    const args = [
        "template",
        "candidate",
        opts.tarballPath,
        ...(opts.kubeVersion ? ["--kube-version", opts.kubeVersion] : []),
    ];

    try {
        const { stdout } = await execFileAsync(opts.helmBin, args, {
            timeout: opts.timeoutMs,
            maxBuffer: opts.maxOutputBytes,
            killSignal: "SIGKILL",
            env: { ...process.env, HELM_NO_UPDATE_NOTIFICATION: "1" },
        });
        return { ok: true, manifests: stdout };
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
        if (e.killed) {
            return { ok: false, reason: `helm template exceeded the ${opts.timeoutMs}ms timeout` };
        }
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            return {
                ok: false,
                reason: `rendered output exceeded the ${opts.maxOutputBytes}-byte ceiling`,
            };
        }
        if (e.code === "ENOENT") {
            return { ok: false, reason: `helm binary not found at ${opts.helmBin}` };
        }
        const stderr = (e.stderr ?? "").toString().trim().slice(0, 500);
        return { ok: false, reason: stderr || e.message || "helm template failed" };
    }
}

let cachedHelmVersion: string | null | undefined;

/** The binary's version, for `chart_renders.helm_version` provenance. */
export async function helmVersion(helmBin: string): Promise<string | null> {
    if (cachedHelmVersion !== undefined) return cachedHelmVersion;
    try {
        const { stdout } = await execFileAsync(helmBin, ["version", "--template={{.Version}}"], {
            timeout: 10_000,
        });
        cachedHelmVersion = stdout.trim() || null;
    } catch {
        cachedHelmVersion = null;
    }
    return cachedHelmVersion;
}

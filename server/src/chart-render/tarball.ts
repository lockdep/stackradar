/**
 * Fetch a chart tarball under a byte cap.
 *
 * The cap is enforced twice, following `artifacthub-sync/downloader.ts`: on
 * the declared `content-length` before any body is read, and chunk-wise while
 * streaming — a server that lies about its length still cannot push more than
 * the ceiling to disk. `file://` is supported for tests only.
 */

import { createWriteStream } from "node:fs";
import { config } from "../config/index.js";
import { safeFetch } from "../lib/safe-fetch.js";
import { copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type TarballResult =
    | { ok: true; path: string }
    | { ok: false; reason: string };

export async function downloadTarball(
    url: string,
    opts: { destDir: string; maxBytes: number; timeoutMs: number; userAgent: string }
): Promise<TarballResult> {
    const destPath = join(opts.destDir, "chart.tgz");

    if (url.startsWith("file://")) {
        // Test fixture escape hatch only. In production a `file://` tarball
        // URL can only mean a poisoned index or a bug upstream of
        // `resolveTarballUrl` — refuse it unconditionally (S7).
        if (config.isProduction) {
            return { ok: false, reason: "refusing file:// tarball URL" };
        }
        try {
            const sourcePath = fileURLToPath(url);
            const { size } = await stat(sourcePath);
            if (size > opts.maxBytes) {
                return { ok: false, reason: `tarball is ${size} bytes; the ceiling is ${opts.maxBytes}` };
            }
            await copyFile(sourcePath, destPath);
            return { ok: true, path: destPath };
        } catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
    }

    if (!/^https?:\/\//i.test(url)) {
        return { ok: false, reason: `refusing non-http(s) tarball URL: ${url}` };
    }

    let response: Response;
    try {
        // The tarball URL comes from the attacker-controllable index this
        // worker fetched earlier, so it gets the same SSRF guard as the
        // index itself (S7).
        response = await safeFetch(url, {
            headers: { "User-Agent": opts.userAgent },
            timeoutMs: opts.timeoutMs,
            allowInsecureHttp: true,
        });
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    if (!response.ok) {
        return { ok: false, reason: `HTTP ${response.status} fetching chart tarball` };
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
        return { ok: false, reason: `tarball declares ${declared} bytes; the ceiling is ${opts.maxBytes}` };
    }

    if (!response.body) {
        return { ok: false, reason: "tarball response carried no body" };
    }

    const out = createWriteStream(destPath);
    let received = 0;
    try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            received += chunk.byteLength;
            if (received > opts.maxBytes) {
                throw new Error(`tarball exceeded the ${opts.maxBytes}-byte ceiling while streaming`);
            }
            if (!out.write(chunk)) {
                await new Promise<void>((resolve, reject) => {
                    out.once("drain", resolve);
                    out.once("error", reject);
                });
            }
        }
        await new Promise<void>((resolve, reject) => {
            out.end(() => resolve());
            out.once("error", reject);
        });
        return { ok: true, path: destPath };
    } catch (err) {
        out.destroy();
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

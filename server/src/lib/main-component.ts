/**
 * Which component of an image *is* the application — the thread's ask: "I
 * don't need to know about libssl, I need the RCE in Jellyfin".
 *
 * Today `main` means one thing: a Go module whose name is its binary's
 * `mainModule` (`component-tier.ts`, rule 7). That tags the main module of
 * *every* Go binary in an image — and an image like Argo CD ships a dozen.
 * The image's own `ENTRYPOINT` / `CMD` says which executable is the one the
 * image exists to run, and the scanner sends its path (`argv[0]` only —
 * arguments never leave the cluster).
 *
 * Pure. The bar it was evaluated against before shipping: ≥ 90 % precision
 * on the demo organisation's images.
 *
 * ## What it refuses to say
 *
 * - **A wrapper is not the application.** `/bin/sh`, `tini`, `dumb-init`, a
 *   `docker-entrypoint.sh`: the real command is in the arguments we do not
 *   collect, or inside a script we do not read. Falls through to `CMD`, then
 *   gives up.
 * - **An interpreter is not the application.** `java`, `node`, `python`: the
 *   application is the jar or script in the arguments. Null, by design.
 * - **A pod that overrides `command`** runs something else entirely, and the
 *   inventory does not carry it. A known miss, counted in the evaluation.
 */

import type { Tier } from "./component-tier.js";

export interface MainCandidate {
    id: string;
    name: string;
    /** `syft:package:type` */
    packageType: string | null;
    /** `syft:location:0:path` */
    path: string | null;
    /** `syft:metadata:mainModule` */
    mainModule: string | null;
}

export type MainVerdict =
    | { componentId: string; via: "go-main-module" | "binary" }
    | { componentId: null; reason: "no-entrypoint" | "wrapper" | "interpreter" | "not-in-sbom" };

const WRAPPERS = new Set([
    "sh",
    "bash",
    "ash",
    "dash",
    "zsh",
    "busybox",
    "env",
    "tini",
    "dumb-init",
    "su-exec",
    "gosu",
    "s6-svscan",
    "init",
]);
const INTERPRETERS = new Set([
    "java",
    "node",
    "nodejs",
    "python",
    "python3",
    "ruby",
    "php",
    "perl",
    "dotnet",
    "deno",
    "bun",
    "mono",
]);

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function isWrapper(executable: string): boolean {
    const base = basename(executable);
    return WRAPPERS.has(base) || base.endsWith(".sh") || /entrypoint/i.test(base);
}

/** Where a bare command name (`nginx`) can live. Order is the usual `PATH`. */
const PATH_DIRS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

function componentsAt(executable: string, components: readonly MainCandidate[]): MainCandidate[] {
    if (executable.startsWith("/")) return components.filter((c) => c.path === executable);
    // `WORKDIR`-relative paths are not resolvable without the config's WorkingDir; a bare name is.
    if (executable.includes("/"))
        return components.filter((c) => c.path?.endsWith(`/${executable.replace(/^\.\//, "")}`));
    for (const dir of PATH_DIRS) {
        const hit = components.filter((c) => c.path === `${dir}/${executable}`);
        if (hit.length > 0) return hit;
    }
    return [];
}

/**
 * The component the image exists to run, or why none can be named. A hit
 * says how (`go-main-module` — the main module of the Go binary at the
 * entrypoint's path; `binary` — an executable syft fingerprinted there); a
 * miss says why (`no-entrypoint`, `wrapper`, `interpreter`, `not-in-sbom`),
 * interpreter outranking wrapper when both were seen.
 */
export function detectMainComponent(
    image: { entrypoint?: string | null | undefined; cmd?: string | null | undefined },
    components: readonly MainCandidate[],
): MainVerdict {
    const candidates = [image.entrypoint, image.cmd].filter(
        (e): e is string => typeof e === "string" && e.trim() !== "",
    );
    if (candidates.length === 0) return { componentId: null, reason: "no-entrypoint" };

    let sawInterpreter = false;
    let sawWrapper = false;
    for (const executable of candidates) {
        if (isWrapper(executable)) {
            sawWrapper = true;
            continue;
        }
        if (INTERPRETERS.has(basename(executable))) {
            sawInterpreter = true;
            continue;
        }

        const at = componentsAt(executable, components);
        // A Go binary: every module compiled into it shares the binary's path,
        // and one of them is its main module.
        const goMain = at.find(
            (c) => c.packageType === "go-module" && c.mainModule !== null && c.mainModule === c.name,
        );
        if (goMain) return { componentId: goMain.id, via: "go-main-module" };
        // An executable syft fingerprinted: redis-server, nginx, haproxy.
        const binary = at.find((c) => c.packageType === "binary");
        if (binary) return { componentId: binary.id, via: "binary" };
    }

    if (sawInterpreter) return { componentId: null, reason: "interpreter" };
    if (sawWrapper) return { componentId: null, reason: "wrapper" };
    return { componentId: null, reason: "not-in-sbom" };
}

/** `https://github.com/grafana/grafana.git#abc:dir` → `github.com/grafana/grafana`. Null for anything else. */
export function upstreamRepository(source: string | null | undefined): string | null {
    if (!source) return null;
    const match =
        /^(?:https?:\/\/|git@|ssh:\/\/git@)?((?:github|gitlab)\.com|bitbucket\.org|codeberg\.org)[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(
            source.trim(),
        );
    return match ? `${match[1]!.toLowerCase()}/${match[2]}/${match[3]}` : null;
}

/** A candidate from a component's CycloneDX properties — what the ingest has in hand. */
export function mainCandidateOf(
    id: string,
    name: string,
    properties: Iterable<{ name: string; value: string }>,
): MainCandidate {
    const candidate: MainCandidate = { id, name, packageType: null, path: null, mainModule: null };
    for (const p of properties) {
        if (p.name === "syft:package:type") candidate.packageType = p.value;
        else if (p.name === "syft:location:0:path") candidate.path = p.value;
        else if (p.name === "syft:metadata:mainModule") candidate.mainModule = p.value;
    }
    return candidate;
}

/**
 * Apply a verdict to the built-in tiers of one image's components (same order
 * as the candidates, ids being their indexes). Where the image named its
 * application, `main` is that component alone: the other binaries' main
 * modules — helm and kustomize beside Argo CD, gomplate beside Dex — are
 * things the application ships, which is `application`. Where it did not,
 * nothing changes.
 *
 * One move crosses the findings lens on purpose: a fingerprinted executable is
 * base-image tooling by default (node, openssl, busybox), and the one the image
 * exists to run — `redis-server` in the Redis image — is its application.
 */
export function narrowMain(tiers: readonly Tier[], verdict: MainVerdict): Tier[] {
    if (verdict.componentId === null) return [...tiers];
    const index = Number(verdict.componentId);
    return tiers.map((tier, i) => (i === index ? "main" : tier === "main" ? "application" : tier));
}

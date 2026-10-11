import { readFileSync } from "fs";
import { join } from "path";
import { envString } from "./env.js";

/**
 * What this process reports as its version to callers that record it —
 * today only `POST /internal/match`, whose consumer stores it next to every
 * score so a later reader can tell which matcher produced a number.
 *
 * `package.json`'s `version` plus the short git sha when the image was built
 * with one (`GIT_SHA`, a Dockerfile build arg the CI workflow sets from
 * `github.sha`). Read from the working directory, which is the app root in
 * every way the server is started (`pnpm dev`, the tests, `WORKDIR /app` in
 * the image); a missing or unreadable file degrades to `0.0.0` rather than
 * refusing to start, because a version string is not worth an outage.
 */
function packageVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
            version?: unknown;
        };
        return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

function withGitSha(version: string): string {
    const sha = envString("GIT_SHA", "").trim();
    return sha ? `${version}+${sha.slice(0, 7)}` : version;
}

export const SERVER_VERSION: string = withGitSha(packageVersion());

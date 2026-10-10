/**
 * The registry API, anonymously, public registries only (the caller enforces
 * the allowlist). Two consumers:
 *
 * - `resolveDigest` turns a tag into its manifest digest. The stored digest
 *   is the **manifest-list** digest — whatever `Docker-Content-Digest` the
 *   registry reports for the tag, which is the same identity a kubelet
 *   pull-by-tag records. A ref that fails to resolve is a null-digest
 *   observation with a reason; it measures nothing.
 * - `manifestRequest` on a session is the building block the platform
 *   scanner's size pre-flight uses to read an image's manifests before syft
 *   pulls it (platform-scan/image-size.ts).
 *
 * Auth is the standard anonymous Bearer dance: a 401 carrying
 * `WWW-Authenticate: Bearer realm=…` is answered by fetching a token from the
 * realm with no credentials and retrying once. The token is kept on the
 * session so a second manifest in the same repository costs one request, not
 * three. No credential ever exists in this path — a registry that refuses
 * anonymous pulls simply does not resolve.
 */

import { createHash } from "node:crypto";
import { registryApiHost } from "../lib/public-registries.js";

const MANIFEST_ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface RegistryOptions {
    timeoutMs: number;
    userAgent: string;
}

export type DigestResult =
    | { ok: true; digest: string }
    | { ok: false; reason: string };

/** One repository on one registry, holding the anonymous token once earned. */
export interface RegistrySession {
    readonly host: string;
    readonly repository: string;
    readonly opts: RegistryOptions;
    token: string | null;
}

export function openSession(
    ref: { registry: string; repository: string },
    opts: RegistryOptions
): RegistrySession {
    return { host: registryApiHost(ref.registry), repository: ref.repository, opts, token: null };
}

export type ManifestRequestResult =
    | { ok: true; response: Response }
    | { ok: false; reason: string };

function parseBearerChallenge(header: string): { realm: string; params: URLSearchParams } | null {
    if (!/^bearer /i.test(header)) return null;
    const fields = new Map<string, string>();
    for (const match of header.slice("Bearer ".length).matchAll(/(\w+)="([^"]*)"/g)) {
        fields.set(match[1]!, match[2]!);
    }
    const realm = fields.get("realm");
    if (!realm) return null;
    const params = new URLSearchParams();
    for (const [key, value] of fields) {
        if (key !== "realm") params.set(key, value);
    }
    return { realm, params };
}

async function anonymousToken(
    challenge: { realm: string; params: URLSearchParams },
    repository: string,
    opts: RegistryOptions
): Promise<string | null> {
    const url = new URL(challenge.realm);
    for (const [key, value] of challenge.params) url.searchParams.set(key, value);
    if (!url.searchParams.has("scope")) {
        url.searchParams.set("scope", `repository:${repository}:pull`);
    }
    try {
        const response = await fetch(url, {
            headers: { "User-Agent": opts.userAgent, Accept: "application/json" },
            signal: AbortSignal.timeout(opts.timeoutMs),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { token?: unknown; access_token?: unknown };
        const token = body.token ?? body.access_token;
        return typeof token === "string" && token.length > 0 ? token : null;
    } catch {
        return null;
    }
}

/**
 * `GET /v2/<repository>/manifests/<reference>` through the session,
 * answering one Bearer challenge anonymously. A non-2xx status comes back
 * as the response for the caller to read; only a transport failure, a 401
 * without a usable challenge, or a refused token is `ok: false`. The caller
 * owns the response body either way.
 *
 * GET rather than HEAD: some registries omit Docker-Content-Digest on HEAD,
 * and the body is one small JSON manifest either way.
 */
export async function manifestRequest(
    session: RegistrySession,
    reference: string
): Promise<ManifestRequestResult> {
    return registryGet(session, `manifests/${encodeURIComponent(reference)}`, MANIFEST_ACCEPT);
}

/**
 * `GET /v2/<repository>/blobs/<digest>` through the session — an image's
 * config blob, for the layer backfill (`services/image-layer-backfill`).
 * Same challenge handling as {@link manifestRequest}. Registries usually
 * answer a blob with a redirect to object storage; `fetch` follows it and
 * drops the Authorization header on the cross-origin hop, which is what the
 * signed URL wants. Blob GETs do not count against Docker Hub's pull limit;
 * manifest GETs do.
 */
export async function blobRequest(
    session: RegistrySession,
    digest: string
): Promise<ManifestRequestResult> {
    return registryGet(session, `blobs/${encodeURIComponent(digest)}`, "application/json, application/octet-stream");
}

/**
 * Every tag of the session's repository — `GET /v2/<repository>/tags/list`,
 * following the `Link: <…>; rel="next"` pagination up to `maxPages`. The
 * base-image upgrade pass reads it to find a newer tag of a base
 * (`services/base-upgrade.service.ts`). Null on any failure; `rateLimited`
 * says when that failure was a 429, which ends the caller's run.
 */
export async function listTags(
    session: RegistrySession,
    maxPages = 10
): Promise<{ ok: true; tags: string[] } | { ok: false; rateLimited: boolean }> {
    const tags: string[] = [];
    let path: string | null = "tags/list?n=1000";
    for (let page = 0; path !== null && page < maxPages; page++) {
        const result = await registryGet(session, path, "application/json");
        if (!result.ok) return { ok: false, rateLimited: false };
        const { response } = result;
        if (!response.ok) {
            await response.arrayBuffer().catch(() => undefined);
            return { ok: false, rateLimited: response.status === 429 };
        }
        const body = (await response.json().catch(() => null)) as { tags?: unknown } | null;
        if (Array.isArray(body?.tags)) tags.push(...body.tags.filter((t): t is string => typeof t === "string"));

        // `</v2/library/node/tags/list?last=20-slim&n=1000>; rel="next"`
        const next = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(response.headers.get("link") ?? "")?.[1];
        const marker = next ? `/v2/${session.repository}/` : null;
        path = next && marker && next.includes(marker) ? next.slice(next.indexOf(marker) + marker.length) : null;
    }
    return { ok: true, tags };
}

async function registryGet(
    session: RegistrySession,
    path: string,
    accept: string
): Promise<ManifestRequestResult> {
    const url = `https://${session.host}/v2/${session.repository}/${path}`;

    const request = (token: string | null) =>
        fetch(url, {
            method: "GET",
            headers: {
                Accept: accept,
                "User-Agent": session.opts.userAgent,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(session.opts.timeoutMs),
        });

    try {
        let response = await request(session.token);

        if (response.status === 401) {
            await response.arrayBuffer().catch(() => undefined);
            const challenge = parseBearerChallenge(response.headers.get("www-authenticate") ?? "");
            if (!challenge) {
                return { ok: false, reason: "registry requires auth without a Bearer challenge" };
            }
            const token = await anonymousToken(challenge, session.repository, session.opts);
            if (!token) {
                return { ok: false, reason: "registry refused an anonymous token" };
            }
            session.token = token;
            response = await request(token);
        }

        return { ok: true, response };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

export async function resolveDigest(
    ref: { registry: string; repository: string; tag: string },
    opts: RegistryOptions
): Promise<DigestResult> {
    const result = await manifestRequest(openSession(ref, opts), ref.tag);
    if (!result.ok) return result;
    const { response } = result;

    try {
        if (!response.ok) {
            await response.arrayBuffer().catch(() => undefined);
            return { ok: false, reason: `HTTP ${response.status} resolving manifest` };
        }

        const reported = response.headers.get("docker-content-digest");
        // Hashing the body is the spec-defined fallback identity.
        const body = Buffer.from(await response.arrayBuffer());
        if (reported && /^sha\d+:[0-9a-f]+$/i.test(reported)) {
            return { ok: true, digest: reported };
        }
        return { ok: true, digest: `sha256:${createHash("sha256").update(body).digest("hex")}` };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Split an image reference into the parts that identify the bytes.
 *
 * The server-side twin of the scanner's `parse-image-ref.ts`, kept here so an
 * upload that supplies only `imageRef` still lands a well-formed `images` row.
 * The scanner also sends `registry` and `repository` explicitly, but callers
 * with a ref should prefer parsing it and use the explicit values only as the
 * fallback: the explicit fields are parsed from a *display* name, and for a
 * digest-pinned pod that name is a bare config hash — agents ≤0.1.7 sent
 * `repository: 'sha256'` from it — while the ref comes from the runtime's
 * `imageID` and proved the reliable source.
 *
 * `tag` is `undefined` when the ref carries none. Defaulting to `"latest"`
 * would be inventing one — a digest-pinned deployment has no tag at all, and
 * labelling every distinct image `latest` makes them indistinguishable.
 *
 * Examples:
 *   "nginx:1.25"                    → { repository: "nginx",         tag: "1.25",   registry: undefined, digest: undefined }
 *   "docker.io/library/nginx:1.25"  → { repository: "library/nginx", tag: "1.25",   registry: "docker.io" }
 *   "localhost:5000/myapp:dev"      → { repository: "myapp",         tag: "dev",    registry: "localhost:5000" }
 *   "nginx@sha256:abc"              → { repository: "nginx",         tag: undefined, digest: "sha256:abc" }
 *   "sha256:a4a8…" (64 hex)         → { repository: "",              tag: undefined, digest: "sha256:a4a8…" }
 */

/* A bare image ID — `sha256:` plus 64 hex, no name. containerd reports one as
   `containerStatus.image` when a digest-pinned pod gives it no tag, and
   splitting it on the colon would turn the hex into a 64-character "tag".
   Mirrors the scanner's `parse-image-ref.ts`. */
const BARE_IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;

/**
 * A "tag" that is actually a digest: 64 hex characters, with or without the
 * `sha256:` prefix. Old scanner versions recorded containerd's bare image ID
 * as a tag for digest-pinned pods, and some CD pipelines tag images with a
 * digest hex — either way it is not a name a reader recognises. Mirrors
 * `isDigestLikeTag` in the client's formatters.
 */
export function isDigestLikeTag(tag: string): boolean {
    return /^(sha256:)?[a-f0-9]{64}$/i.test(tag);
}

export function parseImageRef(ref: string): {
    registry: string | undefined;
    repository: string;
    tag: string | undefined;
    digest: string | undefined;
} {
    let rest = ref;

    // Digest first: everything after `@` is the digest, and stripping it keeps
    // the `sha256:` colon out of the tag search below.
    let digest: string | undefined;
    const digestIdx = rest.indexOf("@");
    if (digestIdx !== -1) {
        digest = rest.slice(digestIdx + 1) || undefined;
        rest = rest.slice(0, digestIdx);
    }

    // After the digest strip, so `sha256:…@sha256:…` is caught too. The ID is
    // itself a digest — better that than an invented name or tag.
    if (BARE_IMAGE_ID.test(rest)) {
        return { registry: undefined, repository: "", tag: undefined, digest: digest ?? rest };
    }

    // A colon *after the last slash* is a tag; one before it is a registry port.
    let tag: string | undefined;
    const lastSlash = rest.lastIndexOf("/");
    const colonIdx = rest.indexOf(":", lastSlash + 1);
    if (colonIdx !== -1) {
        tag = rest.slice(colonIdx + 1) || undefined;
        rest = rest.slice(0, colonIdx);
    }

    // The first path component is a registry only if it looks like a host.
    const parts = rest.split("/");
    let registry: string | undefined;
    if (parts.length > 1) {
        const first = parts[0]!;
        if (first.includes(".") || first.includes(":") || first === "localhost") {
            registry = parts.shift();
        }
    }

    return { registry, repository: parts.join("/"), tag, digest };
}

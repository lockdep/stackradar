/**
 * The filename a downloaded SBOM is saved under:
 * `<image>-<digest8>.cyclonedx.json`.
 *
 * `image` is the last path segment of the repository (`library/nginx` →
 * `nginx`), reduced to filename-safe characters; `digest8` is the first eight
 * hex characters of the digest, enough to tell two scans of one repository
 * apart and short enough to read. Either half missing falls back to a
 * neutral word rather than producing `-abcd1234.cyclonedx.json`.
 */
export function sbomDocumentFilename(repository: string | null, digest: string | null): string {
    const lastSegment = repository?.split("/").filter(Boolean).pop() ?? "";
    const image = lastSegment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
    const hex = digest?.replace(/^sha256:/, "").slice(0, 8) ?? "";
    const digest8 = /^[0-9a-f]{8}$/i.test(hex) ? hex.toLowerCase() : "unknown";
    return `${image}-${digest8}.cyclonedx.json`;
}

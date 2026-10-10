/**
 * Where an image's CycloneDX document lives: `GET /api/sboms/:id/document`
 * on the BFF, which proxies it verbatim (Content-Disposition included) from
 * Express. `download` asks the server for an attachment named
 * `<image>-<digest8>.cyclonedx.json`; without it the JSON renders inline, so
 * the same URL opens in a new tab as "View".
 */
export function sbomDocumentUrl(sbomId: string, options: { download?: boolean } = {}): string {
    const base = `/api/sboms/${encodeURIComponent(sbomId)}/document`
    return options.download ? `${base}?download=1` : base
}

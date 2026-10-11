/**
 * Which OSV ecosystems the mirror carries.
 *
 * The cloud mirrors everything OSV publishes: one `all.zip`, ~970k
 * advisories, a rebuild measured in hours. A community install is the
 * dashboard for one cluster, and most of that corpus can never match
 * anything it runs. `OSV_ECOSYSTEMS` scopes the mirror to a comma-separated
 * allow-list of OSV *directory* names (`ecosystems.txt` in the bucket:
 * `Alpine`, `Red Hat`, `crates.io`, …); a scoped bootstrap pulls each
 * ecosystem's own `<dir>/all.zip` instead of the global archive, and the
 * incremental sync ignores `modified_id.csv` entries outside the scope.
 *
 * `null` means unscoped — the whole corpus. Unset falls back to the
 * edition's default: the community list below, or everything on the cloud.
 * `*` or `all` asks for everything explicitly in either edition.
 */

/**
 * The community default: the base images and package managers a Kubernetes
 * cluster is made of. The community default fixes this list and records what it
 * costs to bootstrap, per ecosystem. Chainguard and Wolfi are deliberately
 * not in it (decided 10 Oct 2026): their archives are 1.36 GB of the
 * corpus's 2.7 and only matter to clusters running `cgr.dev` images — an
 * operator who does adds them to `OSV_ECOSYSTEMS`, and the admin OSV tab
 * says how.
 */
export const DEFAULT_COMMUNITY_ECOSYSTEMS: readonly string[] = Object.freeze([
    "Alpine",
    "Debian",
    "Ubuntu",
    "Red Hat",
    "Rocky Linux",
    "AlmaLinux",
    "SUSE",
    "openSUSE",
    "Go",
    "npm",
    "PyPI",
    "Maven",
    "RubyGems",
    "crates.io",
    "NuGet",
    "Packagist",
    "Pub",
    "Hex",
]);

export const ECOSYSTEMS_ENV_VAR = "OSV_ECOSYSTEMS";

const EVERYTHING = new Set(["*", "all"]);

/**
 * The pure resolver. Order-preserving, duplicates and blanks dropped, names
 * kept exactly as given: OSV directory names are case-sensitive and may
 * contain spaces (`Red Hat`, `Rocky Linux`), and the bootstrap checks them
 * against the bucket's `ecosystems.txt` before it downloads anything — a
 * typo here must fail the run, not quietly leave a hole in the mirror.
 */
export function parseEcosystems(raw: string | undefined, edition: { isCloud: boolean }): string[] | null {
    const value = (raw ?? "").trim();
    if (value === "") return edition.isCloud ? null : [...DEFAULT_COMMUNITY_ECOSYSTEMS];
    if (EVERYTHING.has(value.toLowerCase())) return null;

    const seen = new Set<string>();
    const names: string[] = [];
    for (const part of value.split(",")) {
        const name = part.trim();
        if (name === "" || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names.length > 0 ? names : null;
}

/**
 * Whether a mirror built with scope `mirrored` answers for every ecosystem in
 * `wanted`. `null` on either side means everything: an unscoped mirror covers
 * any scope, and nothing but an unscoped mirror covers an unscoped request.
 *
 * The question matters because a scoped bootstrap visits each ecosystem once
 * and the incremental sync never revisits anything below the watermark:
 * widening `OSV_ECOSYSTEMS` after the bootstrap adds nothing on its own.
 * `--bootstrap-if-needed` uses this to notice and rebuild.
 */
export function scopeCovers(mirrored: readonly string[] | null, wanted: readonly string[] | null): boolean {
    return missingFromScope(mirrored, wanted).length === 0;
}

/** The ecosystems in `wanted` that a mirror built with `mirrored` does not carry. */
export function missingFromScope(mirrored: readonly string[] | null, wanted: readonly string[] | null): string[] {
    if (mirrored === null) return [];
    if (wanted === null) return ["*"];
    const have = new Set(mirrored);
    return wanted.filter((name) => !have.has(name));
}

/**
 * Parse the bucket's `ecosystems.txt`: one directory name per line, plus a
 * literal `[EMPTY]` placeholder that is not a directory.
 */
export function parseEcosystemsTxt(body: string): Set<string> {
    const names = new Set<string>();
    for (const line of body.split("\n")) {
        const name = line.trim();
        if (name === "" || name === "[EMPTY]") continue;
        names.add(name);
    }
    return names;
}

/** `<base>/<dir>/all.zip`, with the directory name URL-encoded (`Red%20Hat`). */
export function ecosystemArchiveUrl(storageBaseUrl: string, ecosystemDir: string): string {
    return `${storageBaseUrl}/${encodeURIComponent(ecosystemDir)}/all.zip`;
}

/** The bucket's directory listing, next to the archives. */
export function ecosystemsListUrl(storageBaseUrl: string): string {
    return `${storageBaseUrl}/ecosystems.txt`;
}

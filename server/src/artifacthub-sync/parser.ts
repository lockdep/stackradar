/**
 * Parsing the Artifact Hub dump.
 *
 * The dump is one JSON array of packages. Verified live 2026-08-17:
 *
 * ```json
 * {
 *   "name": "redis",
 *   "description": "…",
 *   "latest_version": "28.0.5",
 *   "stars": 511,
 *   "home": "https://bitnami.com",
 *   "official": true,
 *   "repository": { "name": "bitnami", "url": "https://…", "verified": true, "official": true },
 *   "versions": [{ "pkg": "19.3.0", "app": "7.2.4", "kube": ">=1.25.0-0", "deprecated": true }]
 * }
 * ```
 *
 * Every optional field is *omitted* when empty rather than null — `verified`,
 * `official`, `home`, `app`, `kube`, `deprecated` all appear only when set —
 * so parsing is defensive by construction. A package missing `name` or
 * `repository.url` is counted malformed and skipped, never thrown: one broken
 * entry must not cost the other 18k.
 */

import type { ArtifactHubVersion } from "../db/schema/artifact-hub.js";

/** One parsed package, ready for the mirror upsert. */
export interface ParsedArtifactHubPackage {
    name: string;
    repoName: string;
    repoUrl: string;
    description: string | null;
    latestVersion: string | null;
    stars: number;
    repoOfficial: boolean;
    repoVerified: boolean;
    official: boolean;
    homeUrl: string | null;
    versions: ArtifactHubVersion[];
}

export interface ArtifactHubParseResult {
    packages: ParsedArtifactHubPackage[];
    /** Entries skipped for a missing identity field. A large count is a signal. */
    malformed: number;
    /** Entries dropped as later duplicates of a `(repo_name, name)` pair. */
    duplicates: number;
}

const asString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function parseVersions(raw: unknown): ArtifactHubVersion[] {
    if (!Array.isArray(raw)) return [];
    const versions: ArtifactHubVersion[] = [];
    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const v = entry as Record<string, unknown>;
        const pkg = asString(v.pkg);
        if (!pkg) continue;
        versions.push({
            pkg,
            app: asString(v.app),
            kube: asString(v.kube),
            deprecated: v.deprecated === true,
        });
    }
    return versions;
}

/**
 * Parse the whole dump. Throws only if the payload is not an array at all —
 * that is a different feed, not a bad entry.
 *
 * Deduped on `(repo_name, name)`, keeping the first occurrence. The mirror
 * upsert batches many rows into one statement, and PostgreSQL aborts an
 * `INSERT … ON CONFLICT DO UPDATE` that would touch the same row twice
 * ("cannot affect row a second time") — so the dedupe is load-bearing even
 * though the live dump currently has no duplicate pairs.
 */
export function parsePackages(raw: unknown): ArtifactHubParseResult {
    if (!Array.isArray(raw)) {
        throw new Error(`Artifact Hub dump is not a JSON array (got ${raw === null ? "null" : typeof raw})`);
    }

    const seen = new Set<string>();
    const packages: ParsedArtifactHubPackage[] = [];
    let malformed = 0;
    let duplicates = 0;

    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) {
            malformed++;
            continue;
        }
        const pkg = entry as Record<string, unknown>;
        const repository =
            typeof pkg.repository === "object" && pkg.repository !== null
                ? (pkg.repository as Record<string, unknown>)
                : {};

        const name = asString(pkg.name);
        const repoName = asString(repository.name);
        const repoUrl = asString(repository.url);
        if (!name || !repoName || !repoUrl) {
            malformed++;
            continue;
        }

        const key = `${repoName}\u0000${name}`;
        if (seen.has(key)) {
            duplicates++;
            continue;
        }
        seen.add(key);

        packages.push({
            name,
            repoName,
            repoUrl,
            description: asString(pkg.description),
            latestVersion: asString(pkg.latest_version),
            stars: typeof pkg.stars === "number" && Number.isFinite(pkg.stars) ? pkg.stars : 0,
            repoOfficial: repository.official === true,
            repoVerified: repository.verified === true,
            official: pkg.official === true,
            homeUrl: asString(pkg.home),
            versions: parseVersions(pkg.versions),
        });
    }

    return { packages, malformed, duplicates };
}

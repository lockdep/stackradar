/**
 * Does this chart version's `kubeVersion` constraint exclude this cluster?
 *
 * Pure, and refusal-first: the only answers are `ok`, `excluded` and
 * `unknown`, and anything unparseable is `unknown`, which renders as silence.
 * A wrong "excluded" warns a customer off a legitimate upgrade; a wrong "ok"
 * merely fails to warn — so every doubt resolves to saying nothing.
 *
 * The ranges come from Helm charts via Artifact Hub, and Helm uses
 * Masterminds/semver (Go), not node-semver. The dialects mostly agree —
 * hyphen ranges, `||`, `^`/`~`, `.x` wildcards — with one real divergence:
 * Masterminds treats a comma as AND (`">= 1.23.0, < 1.31.0"`), which
 * node-semver does not parse. The normaliser rewrites commas to spaces
 * (node-semver's AND) before parsing. Cluster versions arrive as Kubernetes
 * `gitVersion` strings (`v1.29.4+k3s1`, `v1.30.2-gke.1100`); `semver.coerce`
 * strips the noise down to the numeric triple.
 */

import semver from "semver";

export type KubeCompatibility = "ok" | "excluded" | "unknown";

/**
 * Masterminds range → node-semver range, or null when the result still does
 * not parse. Comma-AND becomes space-AND (comma has no other meaning in
 * either dialect, so the rewrite cannot change a valid range's meaning — only
 * make a Masterminds one parseable). Then, per token: real charts write
 * `>=1.21-0` for `>=1.21.0-0` (a two-segment version with a prerelease),
 * which Masterminds accepts and node-semver rejects — insert the missing
 * patch. The token regex requires exactly two numeric segments, so `1.19.0-0`
 * and bare `1.21` pass through untouched.
 */
export function normalizeKubeRange(kubeRange: string): string | null {
    const normalised = kubeRange
        .replace(/\s*,\s*/g, " ")
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/^([<>=~^]*v?)(\d+\.\d+)(-[0-9A-Za-z.-]+)$/, "$1$2.0$3"))
        .join(" ");
    return semver.validRange(normalised) === null ? null : normalised;
}

export function kubeCompatibility(
    clusterVersion: string | null | undefined,
    kubeRange: string | null | undefined,
): KubeCompatibility {
    if (!clusterVersion || !kubeRange) return "unknown";

    // `coerce` rather than `parse`: gitVersion suffixes (`+k3s1`, `-gke.1100`)
    // are distribution noise, not pre-release semantics — a GKE cluster on
    // 1.30.2-gke.1100 *is* 1.30.2 for a chart's purposes.
    const cluster = semver.coerce(clusterVersion);
    if (!cluster) return "unknown";

    const normalised = normalizeKubeRange(kubeRange);
    if (normalised === null) return "unknown";

    // `includePrerelease`: chart ranges idiomatically pin `-0` bounds
    // (`>=1.23.0-0`) so that pre-release cluster versions still satisfy them;
    // without the flag those bounds exclude almost everything.
    return semver.satisfies(cluster, normalised, { includePrerelease: true }) ? "ok" : "excluded";
}

/**
 * The shared public-registry allowlist —
 * [measuring-candidate-charts.md](../../../docs/proposals/measuring-candidate-charts.md)
 * phase 2/3, anticipated by base-image-recommendations.md phase 3 and shared
 * with public-image-intel.md when that lands.
 *
 * Two jobs, both refusal-shaped:
 *
 * - **What the platform may pull.** The platform scanner resolves tags and
 *   pulls images anonymously, from these hosts only. A registry not listed
 *   here is not "probably fine" — it is a place we do not send traffic, and
 *   an observation whose registry is off-list stays unresolved with a reason.
 * - **Ref normalisation for pairing.** `docker.io` shorthand (`nginx` ≡
 *   `docker.io/library/nginx` ≡ `index.docker.io/library/nginx`) would
 *   otherwise make identical images fail to pair. Only the well-known cases
 *   are normalised; everything else degrades to a missed pair, which is lost
 *   coverage, never a wrong claim.
 */

/** Hosts the platform scanner may talk to, anonymously. */
const PUBLIC_REGISTRIES: ReadonlySet<string> = new Set([
    "docker.io",
    "quay.io",
    "ghcr.io",
    "gcr.io",
    "registry.k8s.io",
    "public.ecr.aws",
    // AWS's Docker Hub mirror (`ecr-public.aws.com/docker/library/redis`),
    // which the argo-cd chart defaults to. Standard registry API and
    // anonymous Bearer token, same as public.ecr.aws.
    "ecr-public.aws.com",
    "mcr.microsoft.com",
    "registry.gitlab.com",
]);

/** `docker.io` spellings that mean the same registry. */
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/**
 * Canonical registry name. A missing registry is Docker Hub — that is the
 * container runtime's rule, not a guess — and Hub aliases collapse to
 * `docker.io`.
 */
export function normalizeRegistry(registry: string | null | undefined): string {
    if (!registry) return "docker.io";
    const lower = registry.toLowerCase();
    return DOCKER_HUB_ALIASES.has(lower) ? "docker.io" : lower;
}

export function isPublicRegistry(registry: string | null | undefined): boolean {
    return PUBLIC_REGISTRIES.has(normalizeRegistry(registry));
}

/**
 * The repository string two images must share to pair —
 * `recommendForRelease`'s rule ("same repository under a different registry is
 * the same image mirrored"), plus the Hub shorthand: a single-segment
 * repository on Docker Hub is an official image and canonicalises to
 * `library/<name>`. Registries other than Docker Hub get no such rewriting.
 */
export function pairRepository(
    registry: string | null | undefined,
    repository: string
): string {
    if (normalizeRegistry(registry) === "docker.io" && !repository.includes("/")) {
        return `library/${repository}`;
    }
    return repository;
}

/**
 * The host the Docker Registry HTTP API lives on. Docker Hub's API host is
 * not its name; everyone else serves `/v2/` on the registry host itself.
 */
export function registryApiHost(registry: string): string {
    return normalizeRegistry(registry) === "docker.io" ? "registry-1.docker.io" : normalizeRegistry(registry);
}

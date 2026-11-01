/**
 * The Dashboard's *where* — one cluster, one namespace, or all of both — as
 * the `/containers` page spells it: `?cluster=<id>` and `?namespace=<name>`,
 * so a scoped Dashboard is a link that means the same thing on the pages it
 * opens. The other filters (window, images, findings) stay in state; this one
 * is the view a reader pastes to a teammate — "look at argocd" — and has to
 * survive a reload.
 *
 * The same two parameters go on every request that accepts them
 * (`GET /api/vulnerabilities`, `/occurrences`): `withinParams`. Blocks whose
 * endpoint does not accept them stay organization-wide and say so.
 */
export type DashboardScope = {
    /** A cluster id, or null for every cluster. */
    clusterId: string | null;
    /** A namespace *name* — it can span clusters — or null for every namespace. */
    namespace: string | null;
};

export const WHOLE_ORGANIZATION: DashboardScope = { clusterId: null, namespace: null };

/** The scope the URL carries; an absent or empty parameter is "all". */
export function readScope(params: URLSearchParams): DashboardScope {
    return { clusterId: params.get('cluster') || null, namespace: params.get('namespace') || null };
}

/** The URL half: writes the scope onto the page's query, deleting what is "all" so a fresh link stays clean. */
export function writeScope(params: URLSearchParams, scope: DashboardScope): URLSearchParams {
    if (scope.clusterId) params.set('cluster', scope.clusterId);
    else params.delete('cluster');
    if (scope.namespace) params.set('namespace', scope.namespace);
    else params.delete('namespace');
    return params;
}

/** The request half: the same two parameters on a query to an endpoint that reads them. */
export function withinParams(params: URLSearchParams, scope: DashboardScope | undefined): URLSearchParams {
    if (scope?.clusterId) params.set('cluster', scope.clusterId);
    if (scope?.namespace) params.set('namespace', scope.namespace);
    return params;
}

export const isScoped = (scope: DashboardScope): boolean => scope.clusterId !== null || scope.namespace !== null;

/**
 * The scope in words, for the chip every scoped block wears: "platform-eu1 /
 * argocd", "platform-eu1", "namespace argocd". Null when nothing is narrowed.
 * A cluster id the organization does not have — a stale link — is still a
 * scope in force, and is named as what it is rather than hidden.
 */
export function scopeWords(scope: DashboardScope, clusterName: string | null): string | null {
    const cluster = scope.clusterId ? (clusterName ?? 'an unknown cluster') : null;
    if (cluster && scope.namespace) return `${cluster} / ${scope.namespace}`;
    if (cluster) return cluster;
    if (scope.namespace) return `namespace ${scope.namespace}`;
    return null;
}

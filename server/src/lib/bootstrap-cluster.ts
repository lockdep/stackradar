/**
 * The community edition's scanner credential, from the environment.
 *
 * A community install is the dashboard for the cluster it runs in, and the
 * scanner is installed with it — so the cluster row and the key the scanner
 * authenticates with must exist before anyone has logged in, and both sides
 * must agree on them without a round trip. The chart renders the same two
 * values into the scanner's Secret (`cluster-id`, `api-key`) and into the
 * server's environment; `ensureDefaultOrganization()` turns them into a
 * `clusters` row with that exact id and an `api_keys` row hashed the way
 * `generateApiKey()` hashes.
 *
 * Pure: no database, no `config` import, so `validateConfig()` can refuse
 * a half-configured pair at boot the way `authProviderProblems()` does for
 * OAuth, and the parser can be unit-tested with a plain object.
 */

export const BOOTSTRAP_CLUSTER_ID_VAR = "BOOTSTRAP_CLUSTER_ID";
export const BOOTSTRAP_CLUSTER_API_KEY_VAR = "BOOTSTRAP_CLUSTER_API_KEY";

export interface BootstrapCluster {
    /** The `clusters.id` to create — the UUID the scanner reports as its cluster. */
    clusterId: string;
    /** The plaintext key the scanner sends as `X-API-Key`. Hashed before storage, never logged. */
    apiKey: string;
}

export class BootstrapClusterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BootstrapClusterError";
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shortest key the bootstrap accepts. `generateApiKey()` makes 32
 * base64url characters (192 bits); a chart fixture may be shorter, but a
 * key under this is a typo, not a credential.
 */
const MIN_KEY_LENGTH = 16;

/**
 * Both unset: no bootstrap, the install has no cluster until one is
 * configured (the readiness probe says so in the community edition). Both
 * set: the credential. Exactly one set, or a malformed value, is a boot
 * error — the same rule as a half-configured OAuth pair: a scanner that
 * cannot authenticate is not a working install with a feature off.
 */
export function readBootstrapCluster(env: Record<string, string | undefined>): BootstrapCluster | null {
    const clusterId = (env[BOOTSTRAP_CLUSTER_ID_VAR] ?? "").trim();
    const apiKey = (env[BOOTSTRAP_CLUSTER_API_KEY_VAR] ?? "").trim();

    if (!clusterId && !apiKey) return null;
    if (!clusterId || !apiKey) {
        throw new BootstrapClusterError(
            `${BOOTSTRAP_CLUSTER_ID_VAR} / ${BOOTSTRAP_CLUSTER_API_KEY_VAR}: only one of the pair is set; set both or neither`,
        );
    }
    if (!UUID.test(clusterId)) {
        throw new BootstrapClusterError(`${BOOTSTRAP_CLUSTER_ID_VAR} must be a UUID`);
    }
    if (apiKey.length < MIN_KEY_LENGTH) {
        throw new BootstrapClusterError(
            `${BOOTSTRAP_CLUSTER_API_KEY_VAR} must be at least ${MIN_KEY_LENGTH} characters`,
        );
    }
    if (/\s/.test(apiKey)) {
        throw new BootstrapClusterError(`${BOOTSTRAP_CLUSTER_API_KEY_VAR} must not contain whitespace`);
    }

    return { clusterId: clusterId.toLowerCase(), apiKey };
}

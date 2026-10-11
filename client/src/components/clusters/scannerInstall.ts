/**
 * The scanner's install command, in one place.
 *
 * Two surfaces render it: the onboarding screen, which has the plaintext key
 * in hand and bakes the credentials into the command so a first install is a
 * single paste, and `ConnectClusterInstructions`, which shows the chart
 * install on its own and creates the Secret in a second step (the key may be
 * long gone there, and a `--set` leaves the key in shell history and the Helm
 * release, which an operator setting up a second cluster may not want).
 */
export const SCANNER_HELM_CHART = 'oci://ghcr.io/lockdep/charts/stackradar-scanner';
/**
 * The hosted product's API, which is also the chart's own default — the
 * install command only emits `--set stackradar.apiUrl` when the target is
 * another origin.
 */
export const HOSTED_API_URL = 'https://api.stackradar.io';
/** What a community install's command says where its API origin should be, until `PUBLIC_API_URL` is set. */
export const API_URL_PLACEHOLDER = '<PUBLIC_API_URL>';

/**
 * Where the install command points the scanner.
 *
 * The invariant: a community install never renders the hosted URL. Before
 * `PUBLIC_API_URL` existed the command defaulted to it everywhere, so a
 * self-hosted operator's first scanner posted its inventory to
 * api.stackradar.io and failed authentication there — the one address that
 * is certainly wrong for them. Unset in the cloud is the hosted origin;
 * unset in the community edition is a placeholder and a sentence telling
 * the admin what to set. Falling back to `window.location.origin` was
 * rejected: the client's origin is not the API's, and a wrong URL that
 * looks right is worse than one that visibly needs filling in.
 */
export function scannerApiUrl(publicApiUrl: string | null, isCloud: boolean): { url: string; placeholder: boolean } {
    const configured = publicApiUrl?.trim().replace(/\/+$/, '');
    if (configured) return { url: configured, placeholder: false };
    if (isCloud) return { url: HOSTED_API_URL, placeholder: false };
    return { url: API_URL_PLACEHOLDER, placeholder: true };
}
export const SCANNER_DOCS_URL = 'https://github.com/lockdep/stackradar-scanner';
export const SCANNER_RELEASES_URL = 'https://github.com/lockdep/stackradar-scanner/releases/latest';
/** The marketing site's quick-start doc. */
export const SCANNER_INSTALL_DOCS_URL = 'https://stackradar.io/docs/quick-start';

export function helmInstallCommand({
    chartVersion,
    apiUrl,
    credentials,
}: {
    /** The runtime-configured chart version; `null` renders a `<version>` placeholder. */
    chartVersion: string | null;
    /** From `scannerApiUrl`; only emitted when it differs from the chart default. */
    apiUrl: string;
    /** When given, the chart creates the credentials Secret itself. */
    credentials?: { clusterId: string; apiKey: string };
}): string {
    const args = [`--version ${chartVersion ?? '<version>'}`, '--namespace stackradar --create-namespace'];
    if (apiUrl !== HOSTED_API_URL) args.push(`--set stackradar.apiUrl="${apiUrl}"`);
    if (credentials) {
        args.push(`--set stackradar.clusterId="${credentials.clusterId}"`);
        args.push(`--set stackradar.apiKey="${credentials.apiKey}"`);
    }
    return [`helm install stackradar-scanner ${SCANNER_HELM_CHART}`, ...args].join(' \\\n  ');
}

/**
 * The upgrade for a scanner that is already installed.
 *
 * Not `--reuse-values`: that flag carries the *old chart's defaults* forward
 * along with the user's values, and a released chart stamps its own
 * `image.tag` and `image.digest` into those defaults — so the new chart would
 * be asked to run the old image, and its tag/digest guard fails the upgrade.
 * Feeding the release's user-supplied values back with `-f -` takes every
 * default from the new chart and keeps what the operator set (credentials
 * included). `--reset-then-reuse-values` says the same thing but needs
 * Helm 3.14; this form works on any Helm 3.
 */
export function helmUpgradeCommand(chartVersion: string): string {
    return [
        'helm get values stackradar-scanner --namespace stackradar -o yaml |',
        `helm upgrade stackradar-scanner ${SCANNER_HELM_CHART}`,
        `--version ${chartVersion}`,
        '--namespace stackradar -f -',
    ].join(' \\\n  ');
}

function parseVersion(v: string): [number, number, number] | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Is the scanner a cluster reports older than the release the app advertises.
 *
 * Refusal-first, like the agent's own `isOlderVersion`: a version either side
 * that does not parse (`unknown`, a dev build, an unset `SCANNER_CHART_VERSION`)
 * is "cannot say", and cannot-say never nags anyone to upgrade. Strictly older
 * only — a cluster running ahead of the advertised release is not outdated.
 */
export function isScannerOutdated(running: string | null, advertised: string | null): boolean {
    const a = running ? parseVersion(running) : null;
    const b = advertised ? parseVersion(advertised) : null;
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
}

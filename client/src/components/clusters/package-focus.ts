/**
 * The `?name=` / `?version=` deep link into a package list: the row a search
 * result (or a pasted incident link) means, so the list can open it rather
 * than land the reader on an alphabetical page and leave them to find it.
 * Pure, so the palette's href and the list's auto-unfold are tested against
 * the same two functions.
 */

export const PACKAGE_NAME_PARAM = 'name';
export const PACKAGE_VERSION_PARAM = 'version';

export type PackageFocus = {
    name: string;
    /** Absent means every version of the name — a search hit on a name that runs as several. */
    version: string | undefined;
};

/** The focus a URL carries, or null when it names no package. */
export function readPackageFocus(params: URLSearchParams): PackageFocus | null {
    const name = params.get(PACKAGE_NAME_PARAM);
    if (!name) return null;
    const version = params.get(PACKAGE_VERSION_PARAM);
    return { name, version: version === null ? undefined : version };
}

/**
 * The identity of one list row — the server's own `(name, version)` group
 * key, NUL-separated because a NUL cannot occur in a package name.
 */
export function packageRowKey(name: string, version: string | null): string {
    return `${name}\u0000${version ?? ''}`;
}

/** The rows of a page the focus means: the name exactly, and the version when it says one. */
export function focusedPackageKeys(
    focus: PackageFocus | null,
    packages: readonly { name: string; version: string | null }[],
): string[] {
    if (!focus) return [];
    return packages
        .filter(
            (pkg) => pkg.name === focus.name && (focus.version === undefined || (pkg.version ?? '') === focus.version),
        )
        .map((pkg) => packageRowKey(pkg.name, pkg.version));
}

/**
 * The `/packages` link that opens one package's row: the name, and the
 * version when the caller knows it. The list also seeds its search box with
 * the name, so the page is narrowed to the package as well as opened on it.
 */
export function packageHref(name: string, version?: string | null): string {
    const params = new URLSearchParams({ [PACKAGE_NAME_PARAM]: name });
    if (version) params.set(PACKAGE_VERSION_PARAM, version);
    return `/packages?${params}`;
}

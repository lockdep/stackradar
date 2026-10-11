/**
 * OSV ecosystem strings — what they name, and how they scope a match.
 *
 * An OSV ecosystem is two things glued together with a colon:
 *
 *   Alpine:v3.23                          family "Alpine",  release "v3.23"
 *   Debian:12                             family "Debian",  release "12"
 *   Red Hat:enterprise_linux:8::appstream family "Red Hat", release "enterprise_linux:8::appstream"
 *   PyPI                                  family "PyPI",    release none
 *
 * The family answers *how do I order versions in this ecosystem* (§3.4). The
 * release answers *which distro branch is this advisory about*, and dropping it
 * is how a 2016 CVE fixed in Alpine 3.4 ends up attached to a package from
 * Alpine 3.23.
 *
 * The two are stored as separate columns (`ecosystem_family`,
 * `ecosystem_release`) so release scoping is a SQL filter rather than a
 * post-filter over 587k Red Hat rows.
 */

import type { Scheme } from "./version/index.js";

// ===== Splitting =====

export interface ParsedEcosystem {
    /** The string as stored, untouched. */
    raw: string;
    /** Everything before the first colon: `Red Hat`, `Alpine`, `PyPI`. */
    family: string;
    /** Everything after the first colon, or `null` when there is no suffix. */
    release: string | null;
}

/**
 * Split an OSV ecosystem string into its family and release parts.
 *
 * The split is on the *first* colon only: `Red Hat:enterprise_linux:8::appstream`
 * keeps `enterprise_linux:8::appstream` intact as the release, because the
 * release's internal structure differs per family and is not ours to interpret
 * beyond finding the version number in it (see `releaseVersion`).
 *
 * Returns `null` for an absent or blank ecosystem.
 */
export function parseEcosystem(ecosystem: string | null | undefined): ParsedEcosystem | null {
    if (!ecosystem) return null;

    const raw = ecosystem.trim();
    if (raw === "") return null;

    const colon = raw.indexOf(":");
    if (colon === -1) return { raw, family: raw, release: null };

    const release = raw.slice(colon + 1).trim();
    return {
        raw,
        family: raw.slice(0, colon).trim(),
        release: release === "" ? null : release,
    };
}

// ===== The ecosystem table (Appendix B) =====

export interface EcosystemDefinition {
    /** The family part of the OSV ecosystem string, spelled as OSV spells it. */
    family: string;
    /** The PURL type OSV uses for this ecosystem's `affected.package.purl`. */
    purlType: string;
    /** How versions in this ecosystem are ordered. */
    scheme: Scheme;
}

/**
 * Observed one-to-one mapping of OSV ecosystem family to PURL type, across
 * every archive measured for the rewrite (Appendix B of the plan).
 *
 * Deliberately *not* here: a namespace column. Grype folds Rocky, Alma and
 * CentOS into `redhat`; OSV publishes them as separate ecosystems with their
 * own advisories, so folding them would attach RHEL advisories to Rocky
 * packages. The namespace always comes from the PURL itself — on both the
 * advisory and the component side — which is what keeps them distinct in the
 * match key (`identity.ts`). The one adjustment is spelling, not folding: syft
 * writes the os-release `ID` (`rocky`, `sles`, `azurelinux`) where osv.dev
 * writes `rocky-linux`, `suse`, `azure-linux`, and `identity.ts` maps the
 * former onto the latter for the key. Rocky is still not Red Hat.
 *
 * An ecosystem absent from this table is not an error. It resolves to no
 * scheme, the caller falls back to `fuzzy`, and the result can never be
 * reported as `exact`.
 */
export const ECOSYSTEMS: readonly EcosystemDefinition[] = [
    // Language ecosystems.
    { family: "npm", purlType: "npm", scheme: "semver" },
    { family: "PyPI", purlType: "pypi", scheme: "pep440" },
    { family: "Maven", purlType: "maven", scheme: "maven" },
    { family: "Go", purlType: "golang", scheme: "golang" },
    { family: "NuGet", purlType: "nuget", scheme: "nuget" },
    { family: "RubyGems", purlType: "gem", scheme: "gem" },
    { family: "Packagist", purlType: "composer", scheme: "composer" },
    { family: "crates.io", purlType: "cargo", scheme: "semver" },
    { family: "Hex", purlType: "hex", scheme: "semver" },
    { family: "SwiftURL", purlType: "swift", scheme: "semver" },

    // apk-based distributions.
    { family: "Alpine", purlType: "apk", scheme: "apk" },
    { family: "Wolfi", purlType: "apk", scheme: "apk" },
    { family: "Chainguard", purlType: "apk", scheme: "apk" },
    { family: "MinimOS", purlType: "apk", scheme: "apk" },

    // dpkg-based distributions.
    { family: "Debian", purlType: "deb", scheme: "dpkg" },
    { family: "Ubuntu", purlType: "deb", scheme: "dpkg" },

    // rpm-based distributions.
    { family: "Red Hat", purlType: "rpm", scheme: "rpm" },
    { family: "Rocky Linux", purlType: "rpm", scheme: "rpm" },
    { family: "AlmaLinux", purlType: "rpm", scheme: "rpm" },
    { family: "CentOS", purlType: "rpm", scheme: "rpm" },
    { family: "Oracle Linux", purlType: "rpm", scheme: "rpm" },
    { family: "SUSE", purlType: "rpm", scheme: "rpm" },
    { family: "openSUSE", purlType: "rpm", scheme: "rpm" },
    { family: "Mageia", purlType: "rpm", scheme: "rpm" },
    { family: "Photon OS", purlType: "rpm", scheme: "rpm" },
];

/**
 * Families are looked up case-insensitively. OSV is consistent about casing,
 * but a lookup that silently misses is indistinguishable from an ecosystem we
 * do not know, and that failure mode is a whole distro family going unmatched.
 */
const BY_FAMILY = new Map<string, EcosystemDefinition>(ECOSYSTEMS.map((e) => [e.family.toLowerCase(), e]));

/**
 * PURL type → scheme, derived from `ECOSYSTEMS` rather than written out again.
 * Every family sharing a PURL type also shares its scheme, so the derivation is
 * lossless — and deriving it means the two directions cannot drift apart.
 */
const BY_PURL_TYPE = new Map<string, EcosystemDefinition>(ECOSYSTEMS.map((e) => [e.purlType, e]));

/** Every OSV family that maps to `purlType`. */
export function familiesForPurlType(purlType: string): string[] {
    const type = purlType.toLowerCase();
    return ECOSYSTEMS.filter((e) => e.purlType === type).map((e) => e.family);
}

/**
 * Is this OSV ecosystem family one the table names?
 *
 * A `false` here is not an error — see the note on `ECOSYSTEMS`. It means only
 * that the family brings no scheme and no declared PURL type of its own, which
 * is what `affectedPackageKey` reads to tell a genuine ecosystem we have not
 * catalogued (`Julia`, `Hackage`) apart from a vendor republishing someone
 * else's (`TuxCare`, `Echo`).
 */
export function isKnownFamily(family: string | null | undefined): boolean {
    if (!family) return false;
    return BY_FAMILY.has(family.trim().toLowerCase());
}

/**
 * Does a family in the table publish its advisories under this PURL type?
 *
 * The question `isKnownFamily` cannot answer on its own. An uncatalogued family
 * whose purls carry a type *nobody* in the table claims — `pkg:julia/…`,
 * `pkg:hackage/…` — is its own ecosystem, spelling its own packages. One whose
 * purls carry a type another family already owns — `pkg:npm/…` under
 * `TuxCare:npm` — is naming *that* ecosystem's packages, and is a vendor
 * rebuild of them rather than the upstream release.
 */
export function isKnownPurlType(purlType: string | null | undefined): boolean {
    if (!purlType) return false;
    return BY_PURL_TYPE.has(purlType.trim().toLowerCase());
}

/** The PURL type OSV uses for an ecosystem family, or `null` if unknown. */
export function purlTypeForFamily(family: string | null | undefined): string | null {
    if (!family) return null;
    return BY_FAMILY.get(family.trim().toLowerCase())?.purlType ?? null;
}

/**
 * How to order versions for an OSV ecosystem string.
 *
 * Accepts the full string (`Red Hat:enterprise_linux:8::appstream`); the
 * release suffix is stripped before lookup. Returns `null` when the ecosystem
 * is not in the table — the caller must fall back to `fuzzy` rather than
 * assume semver, because a guess here is a wrong ordering reported as fact.
 */
export function schemeForEcosystem(ecosystem: string | null | undefined): Scheme | null {
    const parsed = parseEcosystem(ecosystem);
    if (!parsed) return null;
    return BY_FAMILY.get(parsed.family.toLowerCase())?.scheme ?? null;
}

/**
 * How to order versions for a PURL type.
 *
 * This is the *component's* scheme. It differs from the advisory's scheme when
 * a record is written against an ecosystem whose type we map differently, which
 * is exactly the case the dual-format retry exists for (`version/index.ts`).
 */
export function schemeForPurlType(purlType: string | null | undefined): Scheme | null {
    if (!purlType) return null;
    return BY_PURL_TYPE.get(purlType.trim().toLowerCase())?.scheme ?? null;
}

// ===== Release scoping =====

/** A release part that is only a version number, optionally `v`-prefixed. */
const NUMERIC_RELEASE = /^v?(\d+(?:\.\d+)*)$/;

/**
 * A release that names a product and ends with its version — the SUSE and
 * openSUSE shape:
 *
 *   Linux Enterprise Server 15 SP7                  → 15 SP7
 *   Linux Enterprise Server 15 SP4-LTSS             → 15 SP4  (support tier dropped)
 *   Linux Enterprise High Performance Computing 15-ESPOS → 15
 *   Linux Enterprise Micro 5.5                      → 5.5
 *   Linux Enterprise Module for Python 3 15 SP6     → 15 SP6  (the last number wins)
 *   Leap 15.6                                       → 15.6
 *   Tumbleweed                                      → nothing
 *
 * The version must follow whitespace: `https://packages.drupal.org/8` ends in
 * a digit too, and reading it as "release 8" is exactly the mistake
 * `releaseVersion` is tested not to make.
 */
const PRODUCT_RELEASE = /(?:^|\s)(\d+(?:\.\d+)*)(?:\s+SP(\d+))?(?:-[A-Za-z][\w-]*)?$/;

/**
 * Pull the distro version out of an ecosystem's release part.
 *
 *   v3.23                         → "3.23"      (Alpine)
 *   12                            → "12"        (Debian)
 *   enterprise_linux:8::appstream → "8"         (Red Hat)
 *   22.04:LTS                     → "22.04"     (Ubuntu)
 *   Pro:20.04:LTS                 → "20.04"     (Ubuntu Pro)
 *   Linux Enterprise Server 15 SP7 → "15.7"     (SUSE)
 *   Linux Enterprise Micro 5.5    → "5.5"       (SUSE)
 *   Leap 15.6                     → "15.6"      (openSUSE)
 *   https://packages.drupal.org/8 → null        (Packagist — not a release at all)
 *
 * The release is split on colons and the first purely numeric segment wins.
 * Segments around it name the product, the variant or the support tier, none of
 * which participate in version compatibility. Failing that, a segment that
 * *ends* in a version after a product name is read (`PRODUCT_RELEASE`).
 *
 * A SUSE service pack becomes a minor version — `15 SP7` → `15.7` — because
 * that is what os-release `VERSION_ID` says on the box (`15.7`), which is what
 * syft puts in the component's `distro=` qualifier. A release with no service
 * pack (`15-LTSS`, the GA release under extended support) reads as `15`, so
 * under the dot-boundary prefix rule below it stays compatible with every
 * `15.x` component — the same way a Red Hat `8` advisory applies to RHEL 8.10.
 * That admits a GA-LTSS row against an SP7 package, but rpm ordering settles
 * it: a service pack never ships an *older* upstream than GA, and an equal
 * upstream carries a higher release tag (`150700.…` over `150000.…`), so the
 * component sits at or above the GA fix. The SP-specific rows — the noise the
 * fix for `sles` had to avoid — are what the `SP` capture keeps apart.
 *
 * `null` means "this ecosystem does not name a distro release", which the
 * compatibility rule below treats as matching everything.
 */
export function releaseVersion(release: string | null | undefined): string | null {
    if (!release) return null;

    const parts = release.split(":").map((p) => p.trim());

    for (const part of parts) {
        const m = NUMERIC_RELEASE.exec(part);
        if (m) return m[1]!;
    }

    for (const part of parts) {
        const m = PRODUCT_RELEASE.exec(part);
        if (m) return m[2] === undefined ? m[1]! : `${m[1]!}.${m[2]!}`;
    }

    return null;
}

/**
 * PURL types whose components are always installed from a *specific* distro
 * release, so a component of this type that names no release is missing
 * information rather than genuinely release-free.
 *
 * Derived from the table above rather than written out again: every family that
 * maps to one of these types is a distro, and every language ecosystem maps to
 * something else. Adding a distro family to `ECOSYSTEMS` therefore scopes it
 * correctly without a second edit here — which matters, because the failure
 * mode of forgetting is silent over-reporting.
 */
export const DISTRO_PURL_TYPES = new Set(
    ECOSYSTEMS.filter((e) => e.scheme === "apk" || e.scheme === "dpkg" || e.scheme === "rpm").map((e) => e.purlType),
);

/**
 * Does this PURL type describe a package installed from a distro release?
 *
 * `apk`, `deb`, `rpm` — yes. `npm`, `pypi`, `golang`, an unknown type, or no
 * type at all — no. Unknown is deliberately *not* treated as a distro: scoping
 * a type we have never seen would drop matches on a guess, and the openings in
 * `isCompatibleRelease` exist precisely to avoid that.
 */
export function isDistroPurlType(purlType: string | null | undefined): boolean {
    if (!purlType) return false;
    return DISTRO_PURL_TYPES.has(purlType.trim().toLowerCase());
}

/**
 * Is an advisory written for `advisoryVersion` applicable to a component from
 * distro version `componentVersion`?
 *
 * This is grype's `compatibleVersion` (`grype/search/distro.go:95`): the
 * advisory's version must be a prefix of the component's *at a dot boundary*.
 *
 *   component 8.10   vs advisory 8     → true   (8.10 is RHEL 8)
 *   component 3.23.3 vs advisory 3.23  → true
 *   component 3.23.3 vs advisory 3.4   → false  (prefix test, not numeric)
 *   component 18.04  vs advisory 8     → false  (not a dot boundary)
 *
 * Two openings, both deliberate:
 *
 * - **No advisory version** — the advisory names no release, so it applies to
 *   the whole family. Here we diverge from grype, which returns false: we follow
 *   osv-scalibr's `Parsed.Equal` semantics instead. This is what replaces the
 *   old "fall back to the full unscoped candidate set when nothing matches"
 *   behaviour — suffix-less advisories surviving the filter is what protects a
 *   component from a distro we do not have a release mapping for, without
 *   re-admitting every other release's advisories alongside it.
 *
 * - **No component version** — nothing to scope against. Whether that is an
 *   opening or a closing depends on `purlType`, which is the whole reason it is
 *   a parameter:
 *
 *   - For a language ecosystem an npm package has no distro and never will, so
 *     scoping it would be nonsense: everything matches (grype's
 *     `fullVersion == ""` case).
 *   - For `apk`/`deb`/`rpm` it means the SBOM producer *withheld* the release.
 *     Admitting every branch is how a 2016 CVE fixed in Alpine 3.4 attaches to
 *     an Alpine 3.23 package, so only release-less advisories survive. grype is
 *     harsher still — `MatchPackageByDistro` returns nothing at all with no
 *     distro (`grype/matcher/internal/distro.go:26-28`) — but that turns an
 *     over-report into a silent under-report, which `ranges.ts:9-21` argues
 *     against. Refusing to guess a branch is the shared intent; keeping the
 *     branch-agnostic advisories is ours.
 *
 * Pass `null` for `purlType` when the type is genuinely unknown — it reads as
 * "not a distro type", i.e. today's behaviour.
 */
export function isCompatibleRelease(
    componentVersion: string | null | undefined,
    advisoryVersion: string | null | undefined,
    purlType: string | null | undefined,
): boolean {
    if (!advisoryVersion) return true;
    if (!componentVersion) return !isDistroPurlType(purlType);
    if (componentVersion === advisoryVersion) return true;

    return (
        componentVersion.startsWith(advisoryVersion) &&
        componentVersion.length > advisoryVersion.length &&
        componentVersion[advisoryVersion.length] === "."
    );
}

/**
 * The release versions an advisory may carry and still pass
 * {@link isCompatibleRelease} for this component — the same rule, turned
 * around so the candidate store can apply it as a SQL predicate on
 * `vulnerability_affected_packages.release_version` *before* the rows leave
 * the database (`deb/ubuntu|linux` alone is 52k rows across 19 releases, of
 * which one is wanted).
 *
 *   ("22.04",  "deb")  → ["22", "22.04"]        rows with one of these, or none
 *   ("3.23.3", "apk")  → ["3", "3.23", "3.23.3"]
 *   (null,     "deb")  → []                      only release-less rows
 *   (null,     "npm")  → null                    no scoping at all
 *
 * A release-less advisory row (`release_version IS NULL`) is always admitted,
 * matching the first opening in `isCompatibleRelease`; the store adds that
 * disjunct itself. `null` means "do not filter" and `[]` means "nothing but
 * the release-less rows" — they are not the same answer, which is why the
 * empty array is not collapsed into null.
 *
 * The in-memory check stays in `collectPass` as the second guard, exactly as
 * the withdrawn filter is applied twice; the property the tests hold is that
 * for every `(component, advisory, type)`,
 * `isCompatibleRelease(c, a, t) === (a == null || scope == null || scope.includes(a))`.
 */
export function releaseScope(
    componentVersion: string | null | undefined,
    purlType: string | null | undefined,
): readonly string[] | null {
    if (!componentVersion) return isDistroPurlType(purlType) ? [] : null;

    const prefixes: string[] = [];
    for (let i = 0; i < componentVersion.length; i++) {
        if (componentVersion[i] === ".") prefixes.push(componentVersion.slice(0, i));
    }
    prefixes.push(componentVersion);
    return prefixes;
}

/**
 * Does an advisory in `ecosystem` apply to a component of type `purlType` from
 * distro version `componentVersion`?
 *
 * The convenience form of `isCompatibleRelease` that takes the ecosystem string
 * straight off the candidate row.
 */
export function ecosystemMatchesDistro(
    ecosystem: string | null | undefined,
    componentVersion: string | null | undefined,
    purlType: string | null | undefined,
): boolean {
    const parsed = parseEcosystem(ecosystem);
    return isCompatibleRelease(componentVersion, releaseVersion(parsed?.release), purlType);
}

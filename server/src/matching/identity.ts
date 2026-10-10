/**
 * Package identity — turning a PURL into something two sides can agree on.
 *
 * The matcher looks a component up by a **canonical key**: a normalized string
 * computed by `canonicalKey()` from the advisory's `affected.package.purl` at
 * ingest time, and from the component's PURL at match time. A match happens
 * when — and only when — the two keys are byte-identical.
 *
 * That makes `canonicalKey` the single most load-bearing function in the
 * module. Every rule below exists because some real pair of PURLs describes the
 * same package while spelling it differently:
 *
 *   pkg:pypi/Zope_Interface   and  pkg:pypi/zope-interface   are one package
 *   pkg:npm/%40angular/core   and  pkg:npm/@angular/core     are one package
 *   pkg:apk/alpine/curl@8.1?arch=x86_64&distro=alpine-3.23.3 and
 *   pkg:apk/alpine/curl?arch=source                          are one package
 *
 * And, just as importantly, some pairs that *look* foldable are not:
 *
 *   pkg:golang/github.com/CosmWasm/wasmvm/v2  is not  .../cosmwasm/wasmvm
 *   pkg:golang/github.com/foo/bar/v2          is not  .../foo/bar
 *   pkg:rpm/rocky/openssl                     is not  pkg:rpm/redhat/openssl
 *
 * …while `pkg:rpm/rocky/openssl` (syft, from os-release) *is*
 * `pkg:rpm/rocky-linux/openssl` (osv.dev) — see `DISTRO_NAMESPACE_ALIASES`.
 *
 * Those last two Go rules are about the *module path*, not about where a
 * producer chose to break it: syft 1.19.0 writes the tail of a Go path in the
 * PURL subpath, so `.../foo/bar@1.0#v2` and `.../foo/bar/v2@1.0` name one
 * module. `foldSubpathIntoName` puts it back before any of this runs.
 *
 * The key format (`<type>[/<distro-namespace>]|<name>`) is an implementation
 * detail owned by this file — but it is a *persisted* one. It is written into
 * `vulnerability_affected_packages.match_key`, so changing any rule here
 * requires re-ingesting the mirror.
 */

import { PackageURL } from "packageurl-js";

import {
    isDistroPurlType,
    isKnownFamily,
    isKnownPurlType,
    parseEcosystem,
    purlTypeForFamily,
} from "./ecosystem.js";

// ===== Types =====

/** The distro a component was installed from, per its `distro=` qualifier. */
export interface DistroRef {
    /** Distro id as the scanner wrote it: `alpine`, `rhel`, `debian`. */
    id: string;
    /** Full version: `3.23.3`, `8.10`, `12`. Null when the qualifier gave none. */
    version: string | null;
}

/** The source package a binary package was built from, per `upstream=`. */
export interface UpstreamRef {
    name: string;
    /**
     * The upstream version, spelled as the qualifier spelled it — epoch
     * included when it carried one. Null when the qualifier named only a
     * package.
     */
    version: string | null;
    /**
     * The epoch, surfaced separately for rpm source filenames that carry one.
     * Never synthesised: an upstream with no epoch reports `null` here rather
     * than `"0"`, because a missing epoch is missing information, not a zero.
     */
    epoch: string | null;
}

/** A PURL, taken apart. */
export interface PackageIdentity {
    /** PURL type, lowercased and de-aliased: `pypi`, `npm`, `golang`, `rpm`. */
    type: string;
    /** PURL namespace, with the type's own casing rules already applied. */
    namespace: string | null;
    /**
     * PURL name. For `golang`, the subpath is folded in first — see
     * `foldSubpathIntoName` — so this is always the full module path tail,
     * however the producer chose to split it.
     */
    name: string;
    version: string | null;
    distro: DistroRef | null;
    upstream: UpstreamRef | null;
}

// ===== Parsing =====

/**
 * PURL types that tools spell differently from the spec.
 *
 * Only `go` is here, because it is the only variant observed. Resist adding
 * speculative entries: an alias that never fires is dead code, but one that
 * maps two genuinely different types together merges two packages forever.
 */
const TYPE_ALIASES: Record<string, string> = {
    go: "golang",
};

function normalizeType(type: string): string {
    const t = type.trim().toLowerCase();
    return TYPE_ALIASES[t] ?? t;
}

/**
 * Fold a Go PURL's subpath back into its name.
 *
 * A Go module is identified by its full module path, and that is what every
 * advisory names: OSV writes `github.com/grafana/pyroscope/api`, and ingest
 * keys it as `golang|github.com/grafana/pyroscope/api`. Syft up to and
 * including 1.19.0 did not spell it that way. It split the path after three
 * segments and put the remainder in the PURL *subpath*:
 *
 *   github.com/grafana/pyroscope/api @v1.2.0
 *     → pkg:golang/github.com/grafana/pyroscope@v1.2.0#api
 *
 * Ignoring the subpath collapses the submodule onto its repository root, and
 * both directions of that are wrong. `pyroscope/api@v1.2.0` inherits every
 * advisory written against `pyroscope` and is range-checked with a version
 * that belongs to a different module — v1.2.0 against "fixed in 1.15.2" — so
 * it reports a critical that does not exist. In the other direction the
 * component can never match its *own* advisories, because those are keyed by
 * the full path the subpath was carrying. The `/vN` rule below has the same
 * hole: `resty/v2` arrives as `.../resty@v2.17.1#v2`, so without this the key
 * is `golang|github.com/go-resty/resty` — the v0/v1 module, which the file
 * header is explicit is a different package.
 *
 * Scoped to Go on purpose. The PURL spec means subpath as a location *within*
 * a package, and for every other type it is not part of the identity — folding
 * it in would invent keys that match nothing. Go is where a producer used it
 * to carry the identity itself.
 *
 * Syft fixed this at some point between 1.19.0 and 1.42.1 — 1.42.1 emits the
 * full path in the name and no Go subpath at all, so once the agent's pin
 * moves this becomes a no-op. It stays regardless: uploads arrive from
 * whatever version a customer is running, and the SBOMs already ingested
 * under 1.19.0 keep their mangled PURLs.
 */
function foldSubpathIntoName(type: string, name: string, subpath: string | null | undefined): string {
    if (type !== "golang") return name;

    const extra = subpath?.trim().replace(/^\/+|\/+$/g, "") ?? "";
    return extra === "" ? name : `${name}/${extra}`;
}

/**
 * A distro qualifier: an id, then a version that starts with a digit.
 *
 * The id is matched lazily so the split lands on the *first* hyphen followed by
 * a digit — `opensuse-leap-15.5` is `opensuse-leap` at `15.5`, not `opensuse`
 * at `leap-15.5`.
 */
const DISTRO_ID_VERSION = /^(.+?)-(\d.*)$/;

function parseDistro(raw: string | undefined): DistroRef | null {
    if (!raw) return null;

    const value = raw.trim();
    if (value === "") return null;

    const m = DISTRO_ID_VERSION.exec(value);
    if (!m) return { id: value.toLowerCase(), version: null };

    return { id: m[1]!.toLowerCase(), version: m[2]! };
}

/**
 * Longest `upstream=` qualifier we will read. Source-RPM filenames are a few
 * dozen characters; anything past this is not a filename and is skipped
 * rather than parsed (security-review-2026-08-22.md § S2).
 */
export const MAX_UPSTREAM_LENGTH = 256;

/** Longest PURL we will parse. `components.purl` is unbounded text. */
export const MAX_PURL_LENGTH = 1024;

/**
 * A source-RPM filename: `<name>-<version>-<release>.<arch>.rpm`.
 *
 * Ported from grype's `rpmPackageNamePattern` (`grype/pkg/package.go:39`),
 * `^(.*)-(.*)-(.*)\.([a-zA-Z][^.]+)\.rpm$`, but as a linear walk rather than
 * the regex: three greedy `(.*)` groups over a scanner-supplied string are
 * O(n³) on a hostile input — a few thousand dashes pinned the worker for a
 * minute (security-review-2026-08-22.md § S2). The split below is what the
 * greedy groups resolve to: the arch is the last dot-segment (it cannot
 * contain a dot), and the outer group claims every hyphen it can, so
 * `version` and `release` are the last two hyphen-separated segments and the
 * name is everything before — `perl-5.26.3-419.el8_4.1.src.rpm` splits at
 * the first hyphen only because there are just two.
 */
function parseSourceRpm(raw: string): UpstreamRef | null {
    if (!raw.endsWith(".rpm")) return null;
    const stem = raw.slice(0, -".rpm".length);

    const dot = stem.lastIndexOf(".");
    if (dot === -1) return null;
    const arch = stem.slice(dot + 1);
    // `[a-zA-Z][^.]+`: a letter then at least one more character. No dot is
    // possible here by construction.
    if (arch.length < 2 || !/^[a-zA-Z]/.test(arch)) return null;

    const head = stem.slice(0, dot);
    const lastDash = head.lastIndexOf("-");
    if (lastDash === -1) return null;
    const prevDash = head.lastIndexOf("-", lastDash - 1);
    if (prevDash === -1) return null;

    const name = head.slice(0, prevDash);
    const version = head.slice(prevDash + 1, lastDash);
    const release = head.slice(lastDash + 1);
    if (name === "" || version === "") return null;

    // `4:5.26.3` — rare in a filename, but harmless to read when it is there.
    // The epoch stays inside `version` so the rpm comparator sees it; the
    // separate field is for callers that need to know it was stated.
    const colon = version.indexOf(":");
    const epoch = colon === -1 ? null : version.slice(0, colon);

    return {
        name,
        version: release === "" ? version : `${version}-${release}`,
        epoch,
    };
}

/** The general upstream form: `name`, or `name@version`. */
function parseNameAtVersion(raw: string): UpstreamRef | null {
    const at = raw.indexOf("@");

    if (at === -1) {
        return raw === "" ? null : { name: raw, version: null, epoch: null };
    }

    const name = raw.slice(0, at).trim();
    const version = raw.slice(at + 1).trim();
    if (name === "") return null;

    return { name, version: version === "" ? null : version, epoch: null };
}

/**
 * Read the `upstream=` qualifier.
 *
 * rpm states its upstream as a source-RPM *filename*; everything else states it
 * as `name` or `name@version`. The filename form is tried first for rpm and
 * falls through to the general form, so an rpm component whose scanner wrote
 * `upstream=perl@5.26.3` still parses.
 */
function parseUpstream(type: string, raw: string | undefined): UpstreamRef | null {
    if (!raw) return null;
    // Skip, don't fail: an oversized upstream costs the component its
    // upstream identity, not the SBOM its ingest.
    if (raw.length > MAX_UPSTREAM_LENGTH) return null;

    const value = raw.trim();
    if (value === "") return null;

    if (type === "rpm") {
        const fromFilename = parseSourceRpm(value);
        if (fromFilename) return fromFilename;
    }

    return parseNameAtVersion(value);
}

/**
 * A qualifier string glued straight onto the name with `&`, in a purl that
 * never opened one with `?`:
 *
 *   pkg:rpm/suse/curl&distro=SUSE%20Linux%20Enterprise%20Server%2015%20SP7
 *   pkg:rpm/opensuse/curl&distro=openSUSE%20Leap%2015.6
 *
 * That is how osv.dev's exporter writes every SUSE and openSUSE purl (checked
 * against the live API on 2026-09-06; no other family does it). Read
 * literally, the package is named `curl&distro=SUSE Linux…`, its key is
 * `rpm/suse|curl&distro=suse linux enterprise server 15 sp7`, and no component
 * can ever meet it — which is what kept every SUSE advisory in the mirror
 * unmatchable. The first `&` of a purl with no `?` before it is the `?` the
 * exporter forgot.
 */
const GLUED_QUALIFIERS = /^([^?#]*?)&(?=[A-Za-z_][\w.-]*=)/;

/**
 * Re-punctuate a purl whose qualifiers were glued on with `&` (see
 * `GLUED_QUALIFIERS`). A purl that already opens its qualifiers with `?` is
 * returned untouched, so this is safe to run on both the advisory and the
 * component side.
 */
export function repairGluedQualifiers(purl: string): string {
    return purl.replace(GLUED_QUALIFIERS, "$1?");
}

/**
 * Parse a PURL into a `PackageIdentity`, or `null` when it is not a PURL.
 *
 * There is no lenient fallback parser. A string that `packageurl-js` rejects
 * has no reliable type/namespace/name split, and guessing one produces a key
 * that matches nothing on the advisory side anyway — it would only convert an
 * honest "we could not read this" into a silent miss. Callers should treat
 * `null` as "this component is not matchable by PURL".
 */
export function parsePurl(purl: string | null | undefined): PackageIdentity | null {
    if (!purl) return null;
    if (purl.length > MAX_PURL_LENGTH) return null;

    let parsed: PackageURL;
    try {
        parsed = PackageURL.fromString(repairGluedQualifiers(purl.trim()));
    } catch {
        return null;
    }

    const type = normalizeType(parsed.type);
    const qualifiers = (parsed.qualifiers ?? {}) as Record<string, string>;

    return {
        type,
        namespace: parsed.namespace ?? null,
        name: foldSubpathIntoName(type, parsed.name, parsed.subpath),
        version: parsed.version ?? null,
        distro: parseDistro(qualifiers.distro),
        upstream: parseUpstream(type, qualifiers.upstream),
    };
}

// ===== The canonical key =====

interface KeyRule {
    /**
     * How the namespace joins the name.
     *
     * `slash`  — `namespace/name`, the PURL's own shape.
     * `colon`  — `namespace:name`, so a Maven key reads as the `groupId:artifactId`
     *            that OSV publishes as the package name.
     * `type`   — the namespace is the distro vendor and belongs to the *type*
     *            half of the key, keeping `rpm/redhat|openssl` distinct from
     *            `rpm/rocky|openssl`.
     */
    namespace: "slash" | "colon" | "type";
    fold: "lower" | "preserve";
    /** Collapse runs of `-`, `_` and `.` to a single `-` (PEP 503). */
    pep503?: boolean;
}

/**
 * Per-type key rules, from §3.2 of the rewrite plan.
 *
 * Case folding is the rule to be careful with. Most ecosystems treat names
 * case-insensitively and OSV stores display casing (`jQuery`), so folding is
 * what makes the two sides meet. Go and Maven do *not*: a Go module path is
 * case-sensitive by definition, and folding `github.com/CosmWasm/wasmvm` would
 * merge it with a genuinely different module.
 */
const KEY_RULES: Record<string, KeyRule> = {
    // OSV's PyPI names are already PEP 503-normalized — of 29,955 affected
    // entries, none carries uppercase, `.` or `_`. All the work here is on the
    // component side.
    pypi: { namespace: "slash", fold: "lower", pep503: true },
    // The `@scope/` is part of the name; `%40` is already decoded by parsing.
    npm: { namespace: "slash", fold: "lower" },
    maven: { namespace: "colon", fold: "preserve" },
    // Full module path, case and `/vN` suffix intact.
    golang: { namespace: "slash", fold: "preserve" },
    nuget: { namespace: "slash", fold: "lower" },
    gem: { namespace: "slash", fold: "lower" },
    composer: { namespace: "slash", fold: "lower" },
    cargo: { namespace: "slash", fold: "lower" },
    apk: { namespace: "type", fold: "lower" },
    deb: { namespace: "type", fold: "lower" },
    rpm: { namespace: "type", fold: "lower" },
};

/**
 * Types with no rule of their own fold case and keep the namespace in the name.
 * Folding is the safer default: it can merge two packages an ecosystem would
 * have kept apart, but the alternative — preserving case — silently drops
 * matches for every ecosystem that is in fact case-insensitive, and the
 * ecosystems that are genuinely case-sensitive are both listed above.
 */
const DEFAULT_KEY_RULE: KeyRule = { namespace: "slash", fold: "lower" };

/**
 * os-release `ID` (what syft writes as the rpm purl namespace) → the namespace
 * osv.dev uses in its purls for the same distro.
 *
 * The `type` rule keys a distro package under its vendor, and that only meets
 * the advisory side when both spell the vendor the same way. syft copies the
 * os-release `ID`; osv.dev has its own spelling; for three families they
 * differ, and every rpm in those families had zero distro findings — in prod
 * on 2026-09-06, 11 SLES, 12 Azure Linux and 1 Rocky image against 131,796,
 * 15,771 and 14,309 affected rows respectively.
 *
 * Applied on the **component side only**: the OSV spelling is the stable one,
 * it is what `match_key` already stores, and rewriting it would mean
 * re-ingesting ~5.5M rows. `identity.namespace` itself is left alone — it is
 * echoed back in `packageName` and `purl` — only the key changes.
 *
 * Aliases here have been checked against real SBOMs (the `distro=` samples in
 * `docs/matcher-fixes-2026-09-06.md`). Candidates that have not, and so are
 * not enabled: `opensuse-leap` / `opensuse-tumbleweed` → `opensuse`,
 * `sle-micro` → `suse`, `mariner` → `azure-linux` (Azure Linux 2 was
 * CBL-Mariner). Add one only after seeing syft's namespace for it.
 */
const DISTRO_NAMESPACE_ALIASES: Record<string, string> = {
    sles: "suse",
    rocky: "rocky-linux",
    azurelinux: "azure-linux",
};

/** The vendor half of a distro key, in osv.dev's spelling. */
function distroVendor(namespace: string): string {
    const lower = namespace.toLowerCase();
    return DISTRO_NAMESPACE_ALIASES[lower] ?? lower;
}

/**
 * The normalized lookup key for an identity.
 *
 * Version and qualifiers never participate: `?arch=source` on OSV's distro
 * purls, `?distro=` and `?upstream=` on the component's, and the version on
 * both sides are all scoping or comparison inputs handled elsewhere.
 */
export function canonicalKey(identity: PackageIdentity): string {
    const rule = KEY_RULES[identity.type] ?? DEFAULT_KEY_RULE;
    const namespace = identity.namespace;

    const typePart =
        rule.namespace === "type" && namespace
            ? `${identity.type}/${distroVendor(namespace)}`
            : identity.type;

    let namePart: string;
    if (rule.namespace === "type" || !namespace) {
        namePart = identity.name;
    } else {
        namePart = `${namespace}${rule.namespace === "colon" ? ":" : "/"}${identity.name}`;
    }

    if (rule.fold === "lower") namePart = namePart.toLowerCase();
    if (rule.pep503) namePart = namePart.replace(/[-_.]+/g, "-");

    return `${typePart}|${namePart}`;
}

/**
 * `canonicalKey` straight from a PURL string, or `null` when it will not parse.
 * This is the form both ingest and match-time lookup call.
 */
export function canonicalKeyForPurl(purl: string | null | undefined): string | null {
    const identity = parsePurl(purl);
    return identity === null ? null : canonicalKey(identity);
}

/**
 * The vendor whose *rebuild* of a package this advisory describes, or `null`
 * when it describes the upstream package itself.
 *
 * OSV carries advisories from vendors who take an upstream package, backport a
 * fix into it, and publish the result under their own ecosystem. For the distro
 * types that is already harmless, because osv.dev gives the rebuild a vendor
 * namespace and `canonicalKey`'s `type` rule keeps it in the type half:
 *
 *   TuxCare:CentOS:6   pkg:rpm/tuxcare/php   → rpm/tuxcare|php   ← isolated
 *
 * For the language ecosystems there is no namespace to carry it, so the purl is
 * spelled exactly as upstream's is and the key collides:
 *
 *   TuxCare:npm        pkg:npm/ajv           → npm|ajv           ← collides
 *   TuxCare:Maven      pkg:maven/org.springframework/spring-core
 *   Echo:PyPi          pkg:pypi/requests
 *
 * A collision here is a vanilla npm install matching a fix that only exists in
 * TuxCare's build of the package. The advisories carry no CVE aliases and no
 * severity, so `collapseAliases` cannot fold them into the upstream CVE either
 * — they are purely additive rows padding every component's finding list.
 *
 * The test is *not* "is this family unknown". Plenty of uncatalogued families
 * are genuine ecosystems publishing their own packages under their own PURL
 * type — `Julia` under `pkg:julia/…`, `Bitnami`, `Hackage`, `opam`, `Pub`,
 * `OSS-Fuzz` — and scoping those would invent a vendor for an upstream package
 * and silently stop matching it. The test is that the family is uncatalogued
 * *and* its purls claim a type some catalogued family already owns: naming
 * another ecosystem's packages while not being that ecosystem is what makes a
 * record a rebuild.
 *
 * Distro types are excluded because they already carry the vendor themselves;
 * scoping them again would produce `rpm/tuxcare/tuxcare|php`.
 */
function forkVendor(ecosystem: string | null | undefined, purlType: string): string | null {
    const family = parseEcosystem(ecosystem)?.family ?? null;
    if (family === null || isKnownFamily(family)) return null;
    if (isDistroPurlType(purlType) || !isKnownPurlType(purlType)) return null;

    return family.toLowerCase();
}

/**
 * Move a key into a vendor's namespace: `npm|ajv` → `npm/tuxcare|ajv`.
 *
 * The vendor joins the *type* half, which is the same shape the distro types
 * already produce and the same reason it works: `canonicalKey` only ever writes
 * a `/` into the type half for a type whose rule is `type`, and no language
 * type has one. So no component key can equal a scoped key — the row stays in
 * the table and visible to admin views, but is unmatchable by construction
 * rather than by a filter someone could later forget.
 */
function scopeToVendor(key: string, vendor: string): string {
    const bar = key.indexOf("|");
    return `${key.slice(0, bar)}/${vendor}|${key.slice(bar + 1)}`;
}

/**
 * The `match_key` to store for one `affected[]` entry of an OSV advisory.
 *
 * The advisory side of the key, and the reason `match_key` can be `NOT NULL`.
 * Every entry gets a key; the three tiers below differ only in how much of the
 * identity the record actually gave us.
 *
 * 1. **The purl.** Effectively always taken: `affected.package.purl` is present
 *    on 100% of affected entries in every ecosystem archive measured (Appendix
 *    A), because osv.dev synthesises it on export. The one adjustment made to
 *    it is `forkVendor`: an advisory from a vendor who rebuilds another
 *    ecosystem's packages is scoped to that vendor, because its purl is spelled
 *    identically to upstream's and would otherwise match upstream's packages.
 *
 * 2. **Ecosystem + package name.** For a record whose purl is absent or
 *    unparseable, the ecosystem family names the purl type and `package.name`
 *    is spelled the way the purl's name would have been — `groupId:artifactId`
 *    for Maven, `@scope/name` for npm, the full module path for Go — so the key
 *    built here is byte-identical to the one the purl would have produced. The
 *    exception is the distro types, whose key carries a vendor namespace this
 *    path cannot know; those keys are well-formed but will not match, which is
 *    the honest outcome for an advisory that named no package coordinates.
 *
 * 3. **A deliberately unmatchable key**, for an ecosystem outside the table
 *    (`OSS-Fuzz`, `Linux`, `Android`). The `?` prefix cannot occur in a purl
 *    type, so no component key can ever equal one of these. The row is kept —
 *    it is still real advisory data, visible to admin views — but it is
 *    excluded from matching by construction rather than by a filter someone
 *    could later forget.
 */
export function affectedPackageKey(
    purl: string | null | undefined,
    ecosystem: string | null | undefined,
    packageName: string
): string {
    const identity = parsePurl(purl);
    if (identity !== null) {
        const key = canonicalKey(identity);
        const vendor = forkVendor(ecosystem, identity.type);
        return vendor === null ? key : scopeToVendor(key, vendor);
    }

    const family = parseEcosystem(ecosystem)?.family ?? null;
    const type = purlTypeForFamily(family);

    if (type === null) return `?${family ?? ""}|${packageName}`;

    return canonicalKey({
        type,
        namespace: null,
        name: packageName,
        version: null,
        distro: null,
        upstream: null,
    });
}

/**
 * The identity to run a second, *indirect* match against — the source package
 * this component was built from — or `null` when there is nothing to gain.
 *
 * Distros split one source package into several binary packages: `libcrypto3`
 * and `libssl3` both come from `openssl`, `perl-Errno` from `perl`. OSV writes
 * distro advisories against the source name, so looking up only the binary name
 * misses every advisory for it.
 *
 * Two details that the old implementation got wrong:
 *
 * - **The upstream's version wins.** When the qualifier states one
 *   (`upstream=openssl@3.5.5-r0`), the range check must use it rather than the
 *   component's own. apk subpackages do carry the origin's version, which is
 *   why discarding it looked safe — but dpkg and rpm binary packages routinely
 *   carry a version of their own, and checking a source advisory against a
 *   binary version compares two different things.
 *
 * - **Self-references are dropped**, compared on the canonical key rather than
 *   the raw name. An upstream that resolves to the component's own key would
 *   issue the same lookup twice and label the duplicates `indirect`, which is
 *   how a direct hit gets reported as an indirect one (grype does the same
 *   check in `handleSourceRPM`/`handleDefaultUpstream`).
 */
export function upstreamIdentity(identity: PackageIdentity): PackageIdentity | null {
    const upstream = identity.upstream;
    if (!upstream) return null;

    const synthesised: PackageIdentity = {
        type: identity.type,
        namespace: identity.namespace,
        name: upstream.name,
        version: upstream.version ?? identity.version,
        distro: identity.distro,
        upstream: null,
    };

    if (canonicalKey(synthesised) === canonicalKey(identity)) return null;

    return synthesised;
}

/**
 * Package identity: PURL parsing, the per-type canonical key rules, and the
 * `distro=` / `upstream=` qualifiers.
 *
 * `canonicalKey` is exercised here against **hand-built identities**, not
 * PURL strings. That is deliberate: `packageurl-js` applies some of the same
 * normalization on the way in (it PEP 503-normalizes PyPI names, it lowercases
 * Composer), so asserting the rules only through `canonicalKeyForPurl` would
 * pass even if every rule in `KEY_RULES` were deleted. The end-to-end path is
 * covered separately in `identity.roundtrip.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
    affectedPackageKey,
    canonicalKey,
    canonicalKeyForPurl,
    parsePurl,
    repairGluedQualifiers,
    upstreamIdentity,
} from "../../../src/matching/identity.js";
import type { PackageIdentity } from "../../../src/matching/identity.js";

/** A bare identity, so each test states only the fields it cares about. */
function identity(fields: Partial<PackageIdentity> & { type: string; name: string }): PackageIdentity {
    return {
        namespace: null,
        version: null,
        distro: null,
        upstream: null,
        ...fields,
    };
}

describe("parsePurl()", () => {
    it("repairs a qualifier string glued onto the name with `&`", () => {
        // osv.dev's exporter writes every SUSE and openSUSE purl this way.
        // Read literally the name is `curl&distro=SUSE Linux…`, and the key
        // built from it can never meet a component's.
        const glued = "pkg:rpm/suse/curl&distro=SUSE%20Linux%20Enterprise%20Server%2015%20SP7";

        expect(parsePurl(glued)).toMatchObject({
            type: "rpm",
            namespace: "suse",
            name: "curl",
            version: null,
        });
        expect(canonicalKeyForPurl(glued)).toBe("rpm/suse|curl");
        expect(affectedPackageKey(glued, "SUSE:Linux Enterprise Server 15 SP7", "curl")).toBe("rpm/suse|curl");
        expect(canonicalKeyForPurl("pkg:rpm/opensuse/curl&distro=openSUSE%20Leap%2015.6")).toBe("rpm/opensuse|curl");
    });

    it("leaves a purl that opened its qualifiers with `?` alone", () => {
        expect(repairGluedQualifiers("pkg:apk/alpine/curl@8.1?arch=x86_64&distro=alpine-3.19")).toBe(
            "pkg:apk/alpine/curl@8.1?arch=x86_64&distro=alpine-3.19",
        );
        expect(parsePurl("pkg:apk/alpine/curl@8.1?arch=x86_64&distro=alpine-3.19")?.distro).toEqual({
            id: "alpine",
            version: "3.19",
        });
    });

    it("takes a PURL apart", () => {
        expect(parsePurl("pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1")).toEqual({
            type: "maven",
            namespace: "org.apache.logging.log4j",
            name: "log4j-core",
            version: "2.14.1",
            distro: null,
            upstream: null,
        });
    });

    it("lowercases the type and resolves the `go` spelling to `golang`", () => {
        expect(parsePurl("pkg:PYPI/Foo@1.0")?.type).toBe("pypi");
        expect(parsePurl("pkg:go/github.com/foo/bar@1.0.0")?.type).toBe("golang");
        expect(parsePurl("pkg:golang/github.com/foo/bar@1.0.0")?.type).toBe("golang");
    });

    it("returns null rather than guessing at something that is not a PURL", () => {
        // A null key means "not matchable by PURL". A guessed one would produce
        // a key that matches nothing anyway, but reads as a confident miss.
        expect(parsePurl("not-a-purl")).toBeNull();
        expect(parsePurl("")).toBeNull();
        expect(parsePurl(null)).toBeNull();
        expect(parsePurl(undefined)).toBeNull();
        expect(canonicalKeyForPurl("not-a-purl")).toBeNull();
    });
});

describe("canonicalKey() — per-type rules", () => {
    it("pypi: lowercases and collapses [-_.] runs to a single dash", () => {
        const key = "pypi|zope-interface";
        for (const name of [
            "zope-interface",
            "Zope_Interface",
            "Zope.Interface",
            "ZOPE__INTERFACE",
            "zope-.-interface",
        ]) {
            expect(canonicalKey(identity({ type: "pypi", name })), name).toBe(key);
        }
    });

    it("npm: lowercases and keeps the @scope", () => {
        expect(canonicalKey(identity({ type: "npm", namespace: "@angular", name: "core" }))).toBe("npm|@angular/core");
        expect(canonicalKey(identity({ type: "npm", name: "Example-Package" }))).toBe("npm|example-package");
    });

    it("maven: joins groupId and artifactId with a colon, preserving case", () => {
        // OSV publishes the Maven package name as `groupId:artifactId`; the key
        // is built to read the same way.
        expect(
            canonicalKey(
                identity({
                    type: "maven",
                    namespace: "org.jenkins-ci.plugins.workflow",
                    name: "workflow-cps",
                }),
            ),
        ).toBe("maven|org.jenkins-ci.plugins.workflow:workflow-cps");

        expect(canonicalKey(identity({ type: "maven", namespace: "com.example", name: "MyLib" }))).toBe(
            "maven|com.example:MyLib",
        );
    });

    it("golang: preserves case and the /vN major-version suffix", () => {
        // Go module paths are case-sensitive and `/v2` is part of the identity,
        // so this is the one place folding would merge distinct modules.
        expect(
            canonicalKey(
                identity({
                    type: "golang",
                    namespace: "github.com/CosmWasm/wasmvm",
                    name: "v2",
                }),
            ),
        ).toBe("golang|github.com/CosmWasm/wasmvm/v2");
    });

    it("nuget, gem, cargo and composer: lowercase", () => {
        expect(canonicalKey(identity({ type: "nuget", name: "jQuery" }))).toBe("nuget|jquery");
        expect(canonicalKey(identity({ type: "gem", name: "ActionPack" }))).toBe("gem|actionpack");
        expect(canonicalKey(identity({ type: "cargo", name: "Serde" }))).toBe("cargo|serde");
        expect(canonicalKey(identity({ type: "composer", namespace: "GetGrav", name: "Grav" }))).toBe(
            "composer|getgrav/grav",
        );
    });

    it("apk, deb and rpm: the distro vendor is part of the type half of the key", () => {
        expect(canonicalKey(identity({ type: "apk", namespace: "alpine", name: "apache2" }))).toBe(
            "apk/alpine|apache2",
        );
        expect(canonicalKey(identity({ type: "deb", namespace: "debian", name: "bash" }))).toBe("deb/debian|bash");
        expect(canonicalKey(identity({ type: "rpm", namespace: "redhat", name: "OpenSSL" }))).toBe(
            "rpm/redhat|openssl",
        );
    });

    it("keeps rpm vendors apart rather than aliasing them onto redhat", () => {
        // Grype folds Rocky, Alma and CentOS into `redhat`. OSV publishes them
        // as separate ecosystems with their own advisories, so folding them
        // would attach RHEL advisories to Rocky packages.
        const vendors = ["redhat", "rocky", "almalinux", "centos", "oraclelinux"];
        const keys = vendors.map((v) => canonicalKey(identity({ type: "rpm", namespace: v, name: "openssl" })));
        expect(new Set(keys).size).toBe(vendors.length);
    });

    it("spells the rpm vendor the way osv.dev does, not the way os-release does", () => {
        // syft writes the os-release ID as the namespace; osv.dev has its own
        // spelling for three of them. Same vendor, so same key.
        expect(canonicalKeyForPurl("pkg:rpm/rocky/curl@1?distro=rocky-8.9")).toBe("rpm/rocky-linux|curl");
        expect(canonicalKeyForPurl("pkg:rpm/sles/curl@1?distro=sles-15.7")).toBe("rpm/suse|curl");
        expect(canonicalKeyForPurl("pkg:rpm/azurelinux/openssl@1?distro=azurelinux-3.0")).toBe(
            "rpm/azure-linux|openssl",
        );
        // The advisory side already uses osv.dev's spelling and is untouched.
        expect(canonicalKeyForPurl("pkg:rpm/rocky-linux/curl?distro=rocky-linux-8")).toBe("rpm/rocky-linux|curl");
        // Vendors both sides spell alike are untouched.
        expect(canonicalKeyForPurl("pkg:rpm/almalinux/curl@1")).toBe("rpm/almalinux|curl");
        expect(canonicalKeyForPurl("pkg:rpm/redhat/curl@1")).toBe("rpm/redhat|curl");
    });

    it("aliases the key, not the identity", () => {
        // `namespace` is echoed back in the package name and purl the product
        // shows; only the lookup key adopts osv.dev's spelling.
        const parsed = parsePurl("pkg:rpm/rocky/curl@7.61.1-33.el8?distro=rocky-8.9")!;
        expect(parsed.namespace).toBe("rocky");
        expect(canonicalKey(parsed)).toBe("rpm/rocky-linux|curl");
    });

    it("falls back to lowercasing for a type it has no rule for", () => {
        expect(canonicalKey(identity({ type: "swift", namespace: "github.com/Apple", name: "NIO" }))).toBe(
            "swift|github.com/apple/nio",
        );
        expect(canonicalKey(identity({ type: "hex", name: "Plug" }))).toBe("hex|plug");
    });

    it("ignores the version and every qualifier", () => {
        const base = identity({ type: "apk", namespace: "alpine", name: "curl" });
        const dressed = identity({
            type: "apk",
            namespace: "alpine",
            name: "curl",
            version: "8.17.0-r1",
            distro: { id: "alpine", version: "3.23.3" },
            upstream: { name: "curl-dev", version: "8.17.0-r1", epoch: null },
        });

        expect(canonicalKey(dressed)).toBe(canonicalKey(base));
    });
});

describe("the distro= qualifier", () => {
    it("splits the id from the version at the first hyphen before a digit", () => {
        const cases: Array<[string, string, string | null]> = [
            ["alpine-3.23.3", "alpine", "3.23.3"],
            ["rhel-8.10", "rhel", "8.10"],
            ["debian-12", "debian", "12"],
            ["ubuntu-22.04", "ubuntu", "22.04"],
            // A hyphenated distro id must not be split at its own hyphen.
            ["opensuse-leap-15.5", "opensuse-leap", "15.5"],
            // No version stated at all.
            ["alpine", "alpine", null],
        ];

        for (const [qualifier, id, version] of cases) {
            const parsed = parsePurl(`pkg:apk/alpine/curl@1.0?distro=${qualifier}`);
            expect(parsed?.distro, qualifier).toEqual({ id, version });
        }
    });

    it("is absent when the component states no distro", () => {
        expect(parsePurl("pkg:pypi/django@4.0")?.distro).toBeNull();
        expect(parsePurl("pkg:apk/alpine/curl@1.0?arch=x86_64")?.distro).toBeNull();
    });
});

describe("the upstream= qualifier", () => {
    it("reads a bare source package name", () => {
        const parsed = parsePurl("pkg:apk/alpine/libcrypto3@3.5.5-r0?arch=x86_64&upstream=openssl");
        expect(parsed?.upstream).toEqual({ name: "openssl", version: null, epoch: null });
    });

    it("reads name@version", () => {
        const parsed = parsePurl("pkg:apk/alpine/libcrypto3@3.5.5-r0?upstream=openssl%403.5.5-r0");
        expect(parsed?.upstream).toEqual({
            name: "openssl",
            version: "3.5.5-r0",
            epoch: null,
        });
    });

    it("#8 parses an rpm source filename into name and version-release", () => {
        const parsed = parsePurl("pkg:rpm/redhat/perl-Errno@1.28-419.el8_4.1?upstream=perl-5.26.3-419.el8_4.1.src.rpm");

        expect(parsed?.upstream).toEqual({
            name: "perl",
            version: "5.26.3-419.el8_4.1",
            // Never synthesised. A missing epoch is missing information, and
            // zero-filling it here is the `perl-Errno` false positive grype
            // guards against.
            epoch: null,
        });
    });

    it("surfaces an epoch the source filename actually states, without removing it", () => {
        const parsed = parsePurl("pkg:rpm/redhat/perl-Errno@1.28?upstream=perl-4%3A5.26.3-419.el8_4.1.src.rpm");

        // The epoch stays inside the version so the rpm comparator sees it; the
        // separate field only records that it was stated.
        expect(parsed?.upstream).toEqual({
            name: "perl",
            version: "4:5.26.3-419.el8_4.1",
            epoch: "4",
        });
    });

    it("falls back to name@version for an rpm whose scanner did not write a filename", () => {
        const parsed = parsePurl("pkg:rpm/redhat/perl-Errno@1.28?upstream=perl%405.26.3");
        expect(parsed?.upstream).toEqual({ name: "perl", version: "5.26.3", epoch: null });
    });

    it("splits a multi-hyphen source RPM name at the last two hyphens, like grype's greedy regex", () => {
        const parsed = parsePurl("pkg:rpm/redhat/python3-foo@1.0-1.el8?upstream=python3-foo-1.0-1.el8.src.rpm");
        expect(parsed?.upstream).toEqual({ name: "python3-foo", version: "1.0-1.el8", epoch: null });
    });

    it("falls through to name@version when the filename has too few hyphens", () => {
        const parsed = parsePurl("pkg:rpm/redhat/perl@1?upstream=perl-5.26.3.src.rpm");
        expect(parsed?.upstream).toEqual({ name: "perl-5.26.3.src.rpm", version: null, epoch: null });
    });

    it("parses a hostile 10k-dash upstream in linear time", () => {
        // The former `(.*)-(.*)-(.*)` regex backtracked catastrophically on
        // attacker-controlled component names — O(n³), 5,000 dashes took 64 s.
        // Oversized upstreams are now skipped outright (bounded length), and the
        // parser itself is a linear anchored walk.
        const hostile = "a" + "-".repeat(10_000) + ".src.rpm";
        const start = performance.now();
        // The whole PURL is over its own 1,024 cap, so nothing is parsed.
        expect(parsePurl(`pkg:rpm/redhat/x@1?upstream=${encodeURIComponent(hostile)}`)).toBeNull();
        // An upstream over 256 chars inside a PURL under 1,024 is skipped.
        const over = "a" + "-".repeat(400) + ".src.rpm";
        const parsed = parsePurl(`pkg:rpm/redhat/x@1?upstream=${encodeURIComponent(over)}`);
        expect(performance.now() - start).toBeLessThan(100);
        expect(parsed).not.toBeNull();
        expect(parsed?.upstream).toBeNull();

        // Under the cap the walk still has to be linear.
        const short = "a" + "-".repeat(200) + ".src.rpm";
        const t = performance.now();
        parsePurl(`pkg:rpm/redhat/x@1?upstream=${encodeURIComponent(short)}`);
        expect(performance.now() - t).toBeLessThan(100);
    });

    it("refuses a PURL longer than 1,024 characters", () => {
        expect(parsePurl("pkg:npm/" + "a".repeat(1_100) + "@1.0.0")).toBeNull();
    });

    it("is absent when the component states no upstream", () => {
        expect(parsePurl("pkg:apk/alpine/curl@1.0")?.upstream).toBeNull();
    });
});

describe("upstreamIdentity()", () => {
    it("#7 substitutes the upstream's own version for the range check", () => {
        // A deb binary carries a version of its own; the advisory is written
        // against the source. Checking `2.4.1-1ubuntu2` against a range bounded
        // by `2.4.1-1` compares two different things.
        const component = parsePurl(
            "pkg:deb/ubuntu/foo-bin@2.4.1-1ubuntu2?distro=ubuntu-22.04&upstream=foo%402.4.1-1",
        )!;

        const upstream = upstreamIdentity(component)!;
        expect(upstream.name).toBe("foo");
        expect(upstream.version).toBe("2.4.1-1");
        expect(canonicalKey(upstream)).toBe("deb/ubuntu|foo");
    });

    it("#8 carries the source-RPM version across", () => {
        const component = parsePurl(
            "pkg:rpm/redhat/perl-Errno@1.28-419.el8_4.1?distro=rhel-8.10&upstream=perl-5.26.3-419.el8_4.1.src.rpm",
        )!;

        const upstream = upstreamIdentity(component)!;
        expect(canonicalKey(upstream)).toBe("rpm/redhat|perl");
        expect(upstream.version).toBe("5.26.3-419.el8_4.1");
    });

    it("keeps the component's version when the qualifier names only a package", () => {
        // apk subpackages do carry the origin's version, which is why the bare
        // form is the common one on Alpine.
        const component = parsePurl("pkg:apk/alpine/libcrypto3@3.5.5-r0?distro=alpine-3.23.3&upstream=openssl")!;

        const upstream = upstreamIdentity(component)!;
        expect(upstream.name).toBe("openssl");
        expect(upstream.version).toBe("3.5.5-r0");
    });

    it("carries the distro across so the indirect pass is scoped the same way", () => {
        const component = parsePurl("pkg:apk/alpine/libcrypto3@3.5.5-r0?distro=alpine-3.23.3&upstream=openssl")!;

        expect(upstreamIdentity(component)?.distro).toEqual({
            id: "alpine",
            version: "3.23.3",
        });
    });

    it("has nothing to do when there is no upstream", () => {
        expect(upstreamIdentity(parsePurl("pkg:apk/alpine/curl@1.0")!)).toBeNull();
    });

    it("drops a self-reference, comparing on the canonical key", () => {
        // Same package under a different spelling would otherwise issue the
        // same lookup twice and label the duplicates `indirect`.
        const same = parsePurl("pkg:apk/alpine/openssl@3.5.5-r0?upstream=openssl")!;
        expect(upstreamIdentity(same)).toBeNull();

        const differentCase = parsePurl("pkg:rpm/redhat/OpenSSL@3.0.7?upstream=openssl")!;
        expect(upstreamIdentity(differentCase)).toBeNull();
    });
});

describe("canonical key (regression corpus)", () => {
    it("#17 a PyPI component matches the advisory's normalized name", () => {
        expect(canonicalKeyForPurl("pkg:pypi/Zope_Interface@5.0")).toBe(canonicalKeyForPurl("pkg:pypi/zope-interface"));
    });

    it("#18 a Go component's key preserves case and /v2", () => {
        expect(canonicalKeyForPurl("pkg:golang/github.com/CosmWasm/wasmvm/v2@2.1.0")).toBe(
            "golang|github.com/CosmWasm/wasmvm/v2",
        );
    });
});

/**
 * Syft 1.19.0 — the version the scanner agent pins — splits a Go module path
 * after three segments and writes the remainder as the PURL subpath. Dropping
 * it collapsed every Go submodule onto
 * its repository root: in the SBOM this corpus is drawn from, 499 of 1128
 * components carried a subpath and 16 of the 38 reported criticals were
 * submodules inheriting the root module's advisories — `pyroscope/api@v1.2.0`
 * range-checked against "pyroscope fixed in 1.15.2", and so on. grype, fed the
 * same document, reported none of them, because it matches Go by the
 * component's `name` rather than by the PURL.
 */
describe("golang subpaths (syft 1.19.0)", () => {
    it("folds the subpath back into the module path", () => {
        expect(canonicalKeyForPurl("pkg:golang/github.com/grafana/pyroscope@v1.2.0#api")).toBe(
            "golang|github.com/grafana/pyroscope/api",
        );
        expect(canonicalKeyForPurl("pkg:golang/golang.org/x/crypto@v0.0.0-x#x509roots/fallback")).toBe(
            "golang|golang.org/x/crypto/x509roots/fallback",
        );
    });

    it("keys a submodule apart from the root module it was collapsing onto", () => {
        // The false positive: these two must never share a key, or every
        // advisory against the root module lands on the submodule.
        expect(canonicalKeyForPurl("pkg:golang/github.com/grafana/pyroscope@v1.2.0#api")).not.toBe(
            canonicalKeyForPurl("pkg:golang/github.com/grafana/pyroscope@v1.15.0"),
        );
    });

    it("agrees with the spelling advisories are ingested under", () => {
        // The false negative: OSV names the full module path, so the two
        // spellings of one module have to produce one key.
        expect(canonicalKeyForPurl("pkg:golang/github.com/hashicorp/vault@v1.20.0#api")).toBe(
            canonicalKeyForPurl("pkg:golang/github.com/hashicorp/vault/api@v1.20.0"),
        );
    });

    it("recovers the /vN suffix a subpath was carrying", () => {
        // `resty/v2` arrives as `.../resty@v2.17.1#v2`. Without the fold its
        // key is the v0/v1 module — a different package, per this file's own
        // header.
        expect(canonicalKeyForPurl("pkg:golang/github.com/go-resty/resty@v2.17.1#v2")).toBe(
            "golang|github.com/go-resty/resty/v2",
        );
        expect(canonicalKeyForPurl("pkg:golang/github.com/go-resty/resty@v2.17.1#v2")).not.toBe(
            canonicalKeyForPurl("pkg:golang/github.com/go-resty/resty@v1.12.0"),
        );
    });

    it("leaves a subpath alone for every other type", () => {
        // PURL means subpath as a location *within* a package. Only Go had a
        // producer use it to carry the identity, so only Go folds it.
        expect(canonicalKeyForPurl("pkg:npm/lodash@4.17.21#dist")).toBe("npm|lodash");
        expect(canonicalKeyForPurl("pkg:pypi/django@5.0#django/db")).toBe("pypi|django");
    });

    it("is a no-op on newer syft output, which carries no subpath", () => {
        expect(canonicalKeyForPurl("pkg:golang/github.com/grafana/pyroscope/api@v1.2.0")).toBe(
            "golang|github.com/grafana/pyroscope/api",
        );
    });
});

/**
 * Vendor-fork ecosystems — advisories about someone else's rebuild.
 *
 * OSV carries advisories from vendors who take an upstream package, backport a
 * fix, and publish the result under their own ecosystem. osv.dev gives the
 * distro ones a vendor namespace in the purl, so they isolate themselves. The
 * language ones get no namespace: `TuxCare:npm` publishes `pkg:npm/ajv`,
 * spelled identically to upstream's, and a vanilla npm install of `ajv` was
 * matching a fix that only exists in TuxCare's build.
 *
 * Measured on the dev mirror: 30,590 affected entries across seven such
 * ecosystems, the largest being `TuxCare:Maven`'s 23,011 Spring rows.
 *
 * The rule these tests pin is *not* "unknown family". Several uncatalogued
 * families are genuine ecosystems publishing their own packages under their own
 * PURL type, and scoping those would invent a vendor for an upstream package
 * and silently stop matching it.
 */
describe("affectedPackageKey() — vendor-fork ecosystems", () => {
    const forks: Array<[string, string, string, string]> = [
        ["TuxCare:npm", "pkg:npm/ajv", "ajv", "npm/tuxcare|ajv"],
        ["TuxCare:npm", "pkg:npm/%40angular/animations", "@angular/animations", "npm/tuxcare|@angular/animations"],
        [
            "TuxCare:Maven",
            "pkg:maven/org.springframework/spring-core",
            "org.springframework:spring-core",
            "maven/tuxcare|org.springframework:spring-core",
        ],
        ["TuxCare:PyPI", "pkg:pypi/requests", "requests", "pypi/tuxcare|requests"],
        [
            "TuxCare:Packagist",
            "pkg:composer/symfony/http-kernel",
            "symfony/http-kernel",
            "composer/tuxcare|symfony/http-kernel",
        ],
        ["Echo:npm", "pkg:npm/ajv", "ajv", "npm/echo|ajv"],
        ["Echo:PyPi", "pkg:pypi/requests", "requests", "pypi/echo|requests"],
        [
            "Echo:Maven",
            "pkg:maven/org.springframework/spring-core",
            "org.springframework:spring-core",
            "maven/echo|org.springframework:spring-core",
        ],
    ];

    it.each(forks)("%s scopes %s to its vendor", (ecosystem, purl, name, expected) => {
        expect(affectedPackageKey(purl, ecosystem, name)).toBe(expected);
    });

    it.each(forks)("%s can never match the upstream component (%s)", (ecosystem, purl, name) => {
        // The point of the whole rule. A component's key never carries a `/` in
        // its type half for a language type, so a scoped key is unmatchable by
        // construction rather than by a filter someone could later forget.
        expect(affectedPackageKey(purl, ecosystem, name)).not.toBe(canonicalKeyForPurl(purl));
    });

    it("keeps two vendors' rebuilds of one package apart", () => {
        expect(affectedPackageKey("pkg:npm/ajv", "TuxCare:npm", "ajv")).not.toBe(
            affectedPackageKey("pkg:npm/ajv", "Echo:npm", "ajv"),
        );
    });

    it("leaves the upstream ecosystems it shadows completely alone", () => {
        expect(affectedPackageKey("pkg:npm/ajv", "npm", "ajv")).toBe("npm|ajv");
        expect(
            affectedPackageKey("pkg:maven/org.springframework/spring-core", "Maven", "org.springframework:spring-core"),
        ).toBe("maven|org.springframework:spring-core");
        expect(affectedPackageKey("pkg:pypi/requests", "PyPI", "requests")).toBe("pypi|requests");
    });

    /**
     * The regression this rule is one bad generalisation away from causing.
     * Every family here is absent from `ECOSYSTEMS` — but each publishes its
     * *own* packages under a PURL type no catalogued family claims, so each is
     * a genuine ecosystem we have simply not catalogued, not a rebuild of
     * someone else's. Scoping them would stop them matching for good.
     */
    const notForks: Array<[string, string, string, string]> = [
        ["Julia", "pkg:julia/Genie", "Genie", "julia|genie"],
        ["Hackage", "pkg:hackage/aeson", "aeson", "hackage|aeson"],
        ["opam", "pkg:opam/dune", "dune", "opam|dune"],
        ["Pub", "pkg:pub/http", "http", "pub|http"],
        ["Bitnami", "pkg:bitnami/postgresql", "postgresql", "bitnami|postgresql"],
        ["OSS-Fuzz", "pkg:generic/ffmpeg", "ffmpeg", "generic|ffmpeg"],
    ];

    it.each(notForks)("%s is its own ecosystem, not a rebuild", (ecosystem, purl, name, expected) => {
        expect(affectedPackageKey(purl, ecosystem, name)).toBe(expected);
    });

    it("does not scope a distro rebuild twice — the purl already carries the vendor", () => {
        // `canonicalKey`'s `type` rule already puts the vendor in the type
        // half for apk/deb/rpm, which is why these never collided in the first
        // place. Scoping again would produce `rpm/tuxcare/tuxcare|php`.
        expect(affectedPackageKey("pkg:rpm/tuxcare/php", "TuxCare:CentOS:6", "php")).toBe("rpm/tuxcare|php");
        expect(affectedPackageKey("pkg:deb/echo/linux", "Echo", "linux")).toBe("deb/echo|linux");
        expect(affectedPackageKey("pkg:apk/alpaquita/curl", "Alpaquita", "curl")).toBe("apk/alpaquita|curl");
    });

    it("still falls through to the unmatchable tier when there is no purl at all", () => {
        // A fork advisory with no purl has no type to reason about, so it takes
        // the `?family` tier — already unmatchable, for a different reason.
        expect(affectedPackageKey(null, "Echo:Maven", "org.example:thing")).toBe("?Echo|org.example:thing");
    });
});

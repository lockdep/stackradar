/**
 * OSV ecosystem strings: the family/release split, the scheme tables, and the
 * release-compatibility rule that scopes a distro advisory to a distro release.
 *
 * The compatibility cases are the ones to read first — rows 2, 3 and 4 of the
 * plan's regression corpus live here, and between them they are the difference
 * between "every RPM package matches nothing" and "every RPM package matches
 * every release's advisories".
 */

import { describe, expect, it } from "vitest";
import {
    ECOSYSTEMS,
    ecosystemMatchesDistro,
    familiesForPurlType,
    isCompatibleRelease,
    isDistroPurlType,
    parseEcosystem,
    purlTypeForFamily,
    releaseScope,
    releaseVersion,
    schemeForEcosystem,
    schemeForPurlType,
} from "../../../src/matching/ecosystem.js";
import { SCHEMES } from "../../../src/matching/version/index.js";

describe("parseEcosystem()", () => {
    it("splits on the first colon and leaves the release intact", () => {
        const cases: Array<[string, string, string | null]> = [
            ["PyPI", "PyPI", null],
            ["crates.io", "crates.io", null],
            ["Alpine:v3.23", "Alpine", "v3.23"],
            ["Debian:12", "Debian", "12"],
            ["Ubuntu:22.04:LTS", "Ubuntu", "22.04:LTS"],
            ["Ubuntu:Pro:20.04:LTS", "Ubuntu", "Pro:20.04:LTS"],
            [
                "Red Hat:enterprise_linux:8::appstream",
                "Red Hat",
                "enterprise_linux:8::appstream",
            ],
            [
                "Packagist:https://packages.drupal.org/8",
                "Packagist",
                "https://packages.drupal.org/8",
            ],
        ];

        for (const [raw, family, release] of cases) {
            expect(parseEcosystem(raw), raw).toEqual({ raw, family, release });
        }
    });

    it("treats an absent, blank or suffix-only ecosystem as having no release", () => {
        expect(parseEcosystem(null)).toBeNull();
        expect(parseEcosystem(undefined)).toBeNull();
        expect(parseEcosystem("   ")).toBeNull();
        expect(parseEcosystem("Alpine:")).toEqual({
            raw: "Alpine:",
            family: "Alpine",
            release: null,
        });
    });
});

describe("the ecosystem table", () => {
    it("names each family exactly once", () => {
        const families = ECOSYSTEMS.map((e) => e.family.toLowerCase());
        expect(new Set(families).size).toBe(families.length);
    });

    it("only uses schemes the version module can dispatch", () => {
        for (const e of ECOSYSTEMS) {
            expect(SCHEMES, e.family).toContain(e.scheme);
        }
    });

    it("agrees with itself: families sharing a PURL type share a scheme", () => {
        // `schemeForPurlType` is derived from this table on the assumption that
        // the mapping is a function of the type alone. If a future entry breaks
        // that — say a `deb` ecosystem ordered as semver — the derivation would
        // silently pick whichever row happened to be last.
        const byType = new Map<string, string>();
        for (const e of ECOSYSTEMS) {
            const seen = byType.get(e.purlType);
            if (seen === undefined) byType.set(e.purlType, e.scheme);
            else expect(e.scheme, `${e.family} (${e.purlType})`).toBe(seen);
        }
    });

    it("maps every family to its PURL type and back", () => {
        expect(purlTypeForFamily("Red Hat")).toBe("rpm");
        expect(purlTypeForFamily("Debian")).toBe("deb");
        expect(purlTypeForFamily("Alpine")).toBe("apk");
        expect(purlTypeForFamily("Go")).toBe("golang");
        expect(purlTypeForFamily("RubyGems")).toBe("gem");
        expect(purlTypeForFamily("Packagist")).toBe("composer");
        expect(purlTypeForFamily("crates.io")).toBe("cargo");

        expect(familiesForPurlType("deb").sort()).toEqual(["Debian", "Ubuntu"]);
        expect(familiesForPurlType("apk")).toContain("Wolfi");
        expect(familiesForPurlType("rpm")).toContain("Rocky Linux");
        expect(familiesForPurlType("pypi")).toEqual(["PyPI"]);
    });

    it("returns null for a family it does not know", () => {
        expect(purlTypeForFamily("CRAN")).toBeNull();
        expect(purlTypeForFamily("")).toBeNull();
        expect(familiesForPurlType("cran")).toEqual([]);
    });
});

describe("schemeForEcosystem()", () => {
    it("resolves through the release suffix", () => {
        expect(schemeForEcosystem("Alpine:v3.23")).toBe("apk");
        expect(schemeForEcosystem("Debian:12")).toBe("dpkg");
        expect(schemeForEcosystem("Red Hat:enterprise_linux:8::appstream")).toBe("rpm");
        expect(schemeForEcosystem("Ubuntu:Pro:20.04:LTS")).toBe("dpkg");
        expect(schemeForEcosystem("Packagist:https://packages.drupal.org/8")).toBe("composer");
    });

    it("gives every ecosystem the rewrite added a comparator for its own scheme", () => {
        // Before the rewrite these five returned null and skipped version
        // checking entirely — a fifth of PyPI and Maven version strings are not
        // semver, so falling back to semver would have misordered them.
        expect(schemeForEcosystem("PyPI")).toBe("pep440");
        expect(schemeForEcosystem("Maven")).toBe("maven");
        expect(schemeForEcosystem("RubyGems")).toBe("gem");
        expect(schemeForEcosystem("NuGet")).toBe("nuget");
        expect(schemeForEcosystem("Packagist")).toBe("composer");
    });

    it("gives Go its own scheme, not plain semver", () => {
        // The stdlib spells its versions `go1.24.1`, which semver reads as no
        // version at all — see `version/golang.ts`.
        expect(schemeForEcosystem("Go")).toBe("golang");
    });

    it("is case-insensitive about the family", () => {
        expect(schemeForEcosystem("pypi")).toBe("pep440");
        expect(schemeForEcosystem("RED HAT:enterprise_linux:9")).toBe("rpm");
    });

    it("returns null — never a guess — for an ecosystem it does not know", () => {
        expect(schemeForEcosystem("CRAN")).toBeNull();
        expect(schemeForEcosystem("Hackage")).toBeNull();
        expect(schemeForEcosystem(null)).toBeNull();
    });
});

describe("schemeForPurlType()", () => {
    it("resolves the component side of the comparison", () => {
        const expected: Record<string, string> = {
            npm: "semver",
            pypi: "pep440",
            maven: "maven",
            golang: "golang",
            nuget: "nuget",
            gem: "gem",
            composer: "composer",
            cargo: "semver",
            apk: "apk",
            deb: "dpkg",
            rpm: "rpm",
        };

        for (const [type, scheme] of Object.entries(expected)) {
            expect(schemeForPurlType(type), type).toBe(scheme);
        }
    });

    it("returns null for a type with no comparator", () => {
        expect(schemeForPurlType("cran")).toBeNull();
        expect(schemeForPurlType(null)).toBeNull();
    });
});

describe("releaseVersion()", () => {
    it("finds the release number wherever the family puts it", () => {
        const cases: Array<[string | null, string | null]> = [
            ["v3.23", "3.23"],
            ["v3.4", "3.4"],
            ["12", "12"],
            ["enterprise_linux:8::appstream", "8"],
            ["enterprise_linux:7::server", "7"],
            ["22.04:LTS", "22.04"],
            ["Pro:20.04:LTS", "20.04"],
            [null, null],
        ];

        for (const [release, expected] of cases) {
            expect(releaseVersion(release), String(release)).toBe(expected);
        }
    });

    it("reads a SUSE service pack as a minor version", () => {
        // `15 SP7` is `VERSION_ID=15.7` on the box, which is what syft puts in
        // the component's `distro=` qualifier.
        const cases: Array<[string, string | null]> = [
            ["Linux Enterprise Server 15 SP7", "15.7"],
            ["Linux Enterprise Server 15 SP4-LTSS", "15.4"],
            ["Linux Enterprise Server 15 SP2-BCL", "15.2"],
            ["Linux Enterprise High Performance Computing 15-ESPOS", "15"],
            ["Linux Enterprise Module for Basesystem 15", "15"],
            ["Linux Enterprise Module for Python 3 15 SP6", "15.6"],
            ["Linux Enterprise Micro 5.5", "5.5"],
            ["Enterprise Storage 7.1", "7.1"],
            ["Manager Server 4.3", "4.3"],
            ["Leap 15.6", "15.6"],
            ["Leap Micro 5.5", "5.5"],
            ["Tumbleweed", null],
        ];

        for (const [release, expected] of cases) {
            expect(releaseVersion(release), release).toBe(expected);
        }
    });

    it("reports no release for a suffix that is not a version at all", () => {
        // Packagist's repository-scoped ecosystems are not distro releases, and
        // reading the trailing `8` out of the URL would scope a PHP advisory to
        // "distro version 8".
        expect(releaseVersion("https://packages.drupal.org/8")).toBeNull();
        expect(releaseVersion("LTS")).toBeNull();
        expect(releaseVersion("")).toBeNull();
    });
});

describe("releaseScope()", () => {
    it("is every dot-boundary prefix of the component's release, itself included", () => {
        expect(releaseScope("22.04", "deb")).toEqual(["22", "22.04"]);
        expect(releaseScope("3.23.3", "apk")).toEqual(["3", "3.23", "3.23.3"]);
        expect(releaseScope("12", "deb")).toEqual(["12"]);
        expect(releaseScope("15.7", "rpm")).toEqual(["15", "15.7"]);
    });

    it("admits only release-less rows for a distro component that named no release", () => {
        expect(releaseScope(null, "deb")).toEqual([]);
        expect(releaseScope(undefined, "apk")).toEqual([]);
    });

    it("does not scope a language ecosystem or an unknown type", () => {
        expect(releaseScope(null, "npm")).toBeNull();
        expect(releaseScope(null, null)).toBeNull();
        expect(releaseScope(null, "not-a-type")).toBeNull();
    });

    it("agrees with isCompatibleRelease() on every pair", () => {
        const components = [null, "8", "8.10", "3.23.3", "22.04", "18.04", "15.7", "12"];
        const advisories = [null, "8", "8.1", "8.10", "3.23", "3.4", "22", "22.04", "18", "15", "15.7", "12", "1"];
        const types = ["deb", "apk", "rpm", "npm", null];
        for (const component of components) {
            for (const type of types) {
                const scope = releaseScope(component, type);
                for (const advisory of advisories) {
                    const viaScope = advisory === null || scope === null || scope.includes(advisory);
                    expect(viaScope, `${component} / ${advisory} / ${type}`).toBe(
                        isCompatibleRelease(component, advisory, type)
                    );
                }
            }
        }
    });
});

describe("isDistroPurlType()", () => {
    it("names the three distro package types and nothing else", () => {
        for (const type of ["apk", "deb", "rpm", "APK", " rpm "]) {
            expect(isDistroPurlType(type), type).toBe(true);
        }

        for (const type of ["npm", "pypi", "golang", "maven", "cargo"]) {
            expect(isDistroPurlType(type), type).toBe(false);
        }
    });

    it("does not treat an unknown or absent type as a distro", () => {
        // Scoping a type we have never seen would drop matches on a guess.
        expect(isDistroPurlType("conan")).toBe(false);
        expect(isDistroPurlType(null)).toBe(false);
        expect(isDistroPurlType(undefined)).toBe(false);
        expect(isDistroPurlType("")).toBe(false);
    });
});

describe("isCompatibleRelease()", () => {
    it("matches a release that is a prefix of the component's at a dot boundary", () => {
        expect(isCompatibleRelease("8.10", "8", "rpm")).toBe(true);
        expect(isCompatibleRelease("3.23.3", "3.23", "apk")).toBe(true);
        expect(isCompatibleRelease("12", "12", "deb")).toBe(true);
        expect(isCompatibleRelease("22.04", "22.04", "deb")).toBe(true);
    });

    it("rejects a prefix that is not a dot boundary", () => {
        // The whole point of the boundary test: Ubuntu 18.04 is not RHEL 8.
        expect(isCompatibleRelease("18.04", "8", "deb")).toBe(false);
        expect(isCompatibleRelease("3.230", "3.23", "apk")).toBe(false);
        expect(isCompatibleRelease("12", "1", "deb")).toBe(false);
    });

    it("rejects a different release of the same family", () => {
        expect(isCompatibleRelease("3.23.3", "3.4", "apk")).toBe(false);
        expect(isCompatibleRelease("8.10", "9", "rpm")).toBe(false);
    });

    it("matches everything when a non-distro component names no distro", () => {
        // A language-ecosystem component has nothing to scope against, and
        // never will — an npm package has no release and that is not a gap.
        expect(isCompatibleRelease(null, "8", "npm")).toBe(true);
        expect(isCompatibleRelease("", "8", "pypi")).toBe(true);
        expect(isCompatibleRelease(null, "3.23", null)).toBe(true);
    });

    it("admits only release-less advisories when a distro component names no release", () => {
        // W3: an absent `distro=` on an apk/deb/rpm component is withheld
        // information, not an absent distro. Admitting every branch is how a
        // 2016 CVE fixed in Alpine 3.4 attaches to an Alpine 3.23 package.
        expect(isCompatibleRelease(null, "3.4", "apk")).toBe(false);
        expect(isCompatibleRelease("", "3.23", "apk")).toBe(false);
        expect(isCompatibleRelease(null, "12", "deb")).toBe(false);
        expect(isCompatibleRelease(null, "8", "rpm")).toBe(false);

        // ...but a family-wide advisory still applies. This is where we stop
        // short of grype, which reports nothing at all without a distro.
        expect(isCompatibleRelease(null, null, "apk")).toBe(true);
        expect(isCompatibleRelease(null, "", "rpm")).toBe(true);
    });

    it("matches everything when the advisory names no release", () => {
        // This is the deliberate divergence from grype's compatibleVersion,
        // which returns false here. It is what replaces the old blanket
        // "fall back to the unscoped candidate set" behaviour.
        expect(isCompatibleRelease("8.10", null, "rpm")).toBe(true);
        expect(isCompatibleRelease("42.1", "", "apk")).toBe(true);
        expect(isCompatibleRelease("1.2.3", null, "npm")).toBe(true);
    });
});

describe("release scoping (regression corpus)", () => {
    it("#2 an Alpine 3.23.3 component does not match Alpine:v3.4 advisories", () => {
        expect(ecosystemMatchesDistro("Alpine:v3.4", "3.23.3", "apk")).toBe(false);
    });

    it("#3 a rhel-8.10 component matches Red Hat:enterprise_linux:8::appstream", () => {
        expect(
            ecosystemMatchesDistro("Red Hat:enterprise_linux:8::appstream", "8.10", "rpm")
        ).toBe(true);
    });

    it("#4 a component from an unmapped distro still matches a suffix-less advisory", () => {
        expect(ecosystemMatchesDistro("Photon OS", "5.0", "rpm")).toBe(true);
        expect(ecosystemMatchesDistro("SomeDistroWeHaveNeverSeen", "42.1", "rpm")).toBe(true);
    });

    it("scopes each Alpine branch to itself", () => {
        for (const branch of ["v3.20", "v3.21", "v3.22"]) {
            expect(ecosystemMatchesDistro(`Alpine:${branch}`, "3.23.3", "apk"), branch).toBe(
                false
            );
        }
        expect(ecosystemMatchesDistro("Alpine:v3.23", "3.23.3", "apk")).toBe(true);
    });

    it("scopes a SLES component to its own service pack", () => {
        // `distro=sles-15.7`. Before the SUSE release parser every SUSE
        // ecosystem read as release-less and matched family-wide, which would
        // have attached SP6's fixed versions (`…-150600.4.71.2`) to SP7.
        expect(ecosystemMatchesDistro("SUSE:Linux Enterprise Server 15 SP7", "15.7", "rpm")).toBe(
            true
        );
        expect(
            ecosystemMatchesDistro("SUSE:Linux Enterprise Module for Basesystem 15 SP7", "15.7", "rpm")
        ).toBe(true);
        expect(ecosystemMatchesDistro("SUSE:Linux Enterprise Server 15 SP6", "15.7", "rpm")).toBe(
            false
        );
        expect(ecosystemMatchesDistro("SUSE:Linux Enterprise Server 12 SP5", "15.7", "rpm")).toBe(
            false
        );
        expect(ecosystemMatchesDistro("SUSE:Linux Enterprise Micro 5.5", "15.7", "rpm")).toBe(false);
        expect(ecosystemMatchesDistro("SUSE:Manager Server 4.3", "15.7", "rpm")).toBe(false);
        // The GA release under extended support names no service pack, so it
        // stays compatible with every 15.x — as a Red Hat `8` row is with 8.10.
        expect(ecosystemMatchesDistro("SUSE:Linux Enterprise Server 15-LTSS", "15.7", "rpm")).toBe(
            true
        );
        // …and a GA component does not pick up service-pack rows.
        expect(ecosystemMatchesDistro("SUSE:Linux Enterprise Server 15 SP1", "15", "rpm")).toBe(
            false
        );
        // Tumbleweed is rolling and names no release: family-wide.
        expect(ecosystemMatchesDistro("openSUSE:Tumbleweed", "20240905", "rpm")).toBe(true);
        expect(ecosystemMatchesDistro("openSUSE:Leap 15.5", "15.6", "rpm")).toBe(false);
        expect(ecosystemMatchesDistro("openSUSE:Leap 15.6", "15.6", "rpm")).toBe(true);
    });

    it("never scopes a language ecosystem out", () => {
        expect(ecosystemMatchesDistro("PyPI", null, "pypi")).toBe(true);
        expect(
            ecosystemMatchesDistro("Packagist:https://packages.drupal.org/8", null, "composer")
        ).toBe(true);
    });

    it("scopes an apk component that withheld its distro to release-less advisories", () => {
        // W3 §3.2: the imported-SBOM case. Every Alpine branch shares the base
        // PURL `pkg:apk/alpine/curl`, so without a `distro=` qualifier the only
        // honest answer is the advisories that name no branch.
        for (const branch of ["v3.4", "v3.20", "v3.23"]) {
            expect(ecosystemMatchesDistro(`Alpine:${branch}`, null, "apk"), branch).toBe(false);
        }
        expect(ecosystemMatchesDistro("Alpine", null, "apk")).toBe(true);
    });
});

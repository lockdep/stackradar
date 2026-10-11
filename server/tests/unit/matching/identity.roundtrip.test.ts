/**
 * **The key invariant.**
 *
 * `canonicalKey` runs on two different inputs that must agree: the advisory's
 * `affected.package.purl` at ingest time, and the component's PURL at match
 * time. If they disagree by a single byte, the lookup returns nothing and the
 * vulnerability is silently missed — no error, no log line, just a green check.
 *
 * Every other test in this module checks a rule in isolation. This one checks
 * the property the rules exist to produce: an advisory PURL and a component
 * PURL describing the same package produce the same key, across the ways the
 * two sides are actually spelled differently — the component carries a version,
 * the component carries qualifiers, and the two sides disagree about casing and
 * separators.
 *
 * The advisory purls are real. The language-ecosystem ones are read out of the
 * OSV records in `tests/fixtures/osv-samples/`, so they cannot drift from what
 * the sync pipeline actually ingests. The distro ones are transcribed in the
 * form osv.dev's exporter emits (`?arch=source`, vendor as the namespace) —
 * replace them with fixture-derived purls once the real distro records called
 * for in §6.3 of the plan land.
 *
 * **What the property above could not see.** Every purl it varies is spelled by
 * osv.dev's exporter, which is internally consistent about where a package name
 * breaks across the PURL's fields. Version, qualifiers, casing and separators
 * all vary; the *split* never does. So the invariant as stated held perfectly
 * while syft 1.19.0 was splitting Go module paths into name + subpath and
 * collapsing 499 of one image's 1,128 components onto their repository roots.
 * The corpus in `SPELLINGS` below is the missing half: real purls from two
 * producers who disagree about the split, asserted to reach one key.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalKeyForPurl, parsePurl } from "../../../src/matching/identity.js";

// ===== The advisory-side sample =====

const OSV_SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/osv-samples");

/** Every `affected.package.purl` in the checked-in OSV records. */
function purlsFromOsvSamples(): string[] {
    const purls = new Set<string>();

    for (const file of readdirSync(OSV_SAMPLES_DIR).filter((f) => f.endsWith(".json"))) {
        const record = JSON.parse(readFileSync(join(OSV_SAMPLES_DIR, file), "utf8")) as {
            affected?: Array<{ package?: { purl?: string } }>;
        };

        for (const affected of record.affected ?? []) {
            if (affected.package?.purl) purls.add(affected.package.purl);
        }
    }

    return [...purls].sort();
}

/**
 * Distro advisory purls in osv.dev's export form. Note the `?arch=source`
 * qualifier, which is present on every distro purl OSV publishes and must not
 * reach the key.
 */
const DISTRO_ADVISORY_PURLS = [
    "pkg:apk/alpine/apache2?arch=source",
    "pkg:apk/alpine/openssl?arch=source",
    "pkg:apk/wolfi/curl?arch=source",
    "pkg:deb/debian/bash?arch=source",
    "pkg:deb/ubuntu/openssl?arch=source",
    "pkg:rpm/redhat/openssl?arch=source",
    "pkg:rpm/redhat/perl?arch=source",
];

const ADVISORY_PURLS = [...purlsFromOsvSamples(), ...DISTRO_ADVISORY_PURLS];

/** Go module paths and Maven coordinates are case-sensitive; nothing else is. */
const CASE_SENSITIVE_TYPES = new Set(["golang", "maven"]);

// ===== Component-side spellings =====

function splitQualifiers(purl: string): [string, string] {
    const i = purl.indexOf("?");
    return i === -1 ? [purl, ""] : [purl.slice(0, i), purl.slice(i)];
}

/** The component states a version; the advisory does not. */
function withVersion(purl: string, version: string): string {
    const [base, qualifiers] = splitQualifiers(purl);
    return `${base}@${version}${qualifiers}`;
}

/** The component states the qualifiers the scanner recorded. */
function withQualifiers(purl: string, extra: string): string {
    const [, qualifiers] = splitQualifiers(purl);
    return qualifiers === "" ? `${purl}?${extra}` : `${purl}&${extra}`;
}

/** Rewrite the package-name segment, leaving namespace and qualifiers alone. */
function mapName(purl: string, f: (name: string) => string): string {
    const [base, qualifiers] = splitQualifiers(purl);
    const slash = base.lastIndexOf("/");
    return base.slice(0, slash + 1) + f(base.slice(slash + 1)) + qualifiers;
}

// ===== The property =====

describe("canonicalKey round-trip", () => {
    it("has a sample to work with, and it is advisory-shaped", () => {
        expect(ADVISORY_PURLS.length).toBeGreaterThanOrEqual(10);

        for (const purl of ADVISORY_PURLS) {
            const identity = parsePurl(purl);
            expect(identity, purl).not.toBeNull();
            // Advisory purls name a package, never a version. If this ever
            // fails the variant generation below is building nonsense.
            expect(identity!.version, purl).toBeNull();
        }
    });

    it("gives every advisory purl a key", () => {
        for (const purl of ADVISORY_PURLS) {
            expect(canonicalKeyForPurl(purl), purl).not.toBeNull();
        }
    });

    it("ignores the version the component carries", () => {
        for (const purl of ADVISORY_PURLS) {
            const expected = canonicalKeyForPurl(purl);
            for (const version of ["1.0.0", "8.17.0-r1", "2:3.1.6-7.el3", "1.2.3-4ubuntu2"]) {
                const component = withVersion(purl, version);
                expect(canonicalKeyForPurl(component), component).toBe(expected);
            }
        }
    });

    it("ignores every qualifier, on both sides", () => {
        for (const purl of ADVISORY_PURLS) {
            const expected = canonicalKeyForPurl(purl);

            const variants = [
                withQualifiers(purl, "arch=x86_64"),
                withQualifiers(purl, "distro=alpine-3.23.3"),
                withQualifiers(purl, "upstream=something-else"),
                withQualifiers(withVersion(purl, "1.2.3"), "arch=aarch64&distro=rhel-8.10&upstream=other%401.2.3"),
            ];

            for (const component of variants) {
                expect(canonicalKeyForPurl(component), component).toBe(expected);
            }
        }
    });

    it("folds case for every ecosystem that is case-insensitive", () => {
        const folded = ADVISORY_PURLS.filter((p) => !CASE_SENSITIVE_TYPES.has(parsePurl(p)!.type));
        expect(folded.length).toBeGreaterThan(0);

        for (const purl of folded) {
            const expected = canonicalKeyForPurl(purl);

            for (const f of [(n: string) => n.toUpperCase(), (n: string) => n.charAt(0).toUpperCase() + n.slice(1)]) {
                const component = mapName(purl, f);
                expect(canonicalKeyForPurl(component), component).toBe(expected);
            }
        }
    });

    it("folds PyPI's separators, which is where the two sides disagree most", () => {
        // OSV's PyPI names are already PEP 503-normalized — of 29,955 affected
        // entries, none carries uppercase, `.` or `_`. Every one of these
        // spellings is a component-side one.
        const equivalent: Array<[string, string[]]> = [
            [
                "pkg:pypi/zope-interface",
                [
                    "pkg:pypi/zope_interface@5.0",
                    "pkg:pypi/zope.interface@5.0",
                    "pkg:pypi/Zope.Interface@5.0",
                    "pkg:pypi/ZOPE_INTERFACE@5.0",
                ],
            ],
            ["pkg:pypi/ruamel-yaml", ["pkg:pypi/ruamel.yaml@0.17.21", "pkg:pypi/ruamel_yaml@0.17.21"]],
            ["pkg:pypi/backports-ssl-match-hostname", ["pkg:pypi/backports.ssl_match_hostname@3.7.0.1"]],
        ];

        for (const [advisory, components] of equivalent) {
            const expected = canonicalKeyForPurl(advisory);
            expect(expected, advisory).not.toBeNull();

            for (const component of components) {
                expect(canonicalKeyForPurl(component), component).toBe(expected);
            }
        }
    });

    it("folds an npm scope written percent-encoded or literally", () => {
        const expected = canonicalKeyForPurl("pkg:npm/%40angular/core");
        expect(expected).toBe("npm|@angular/core");
        expect(canonicalKeyForPurl("pkg:npm/@angular/core@16.0.0")).toBe(expected);
    });
});

describe("canonicalKey meets osv.dev's distro spellings", () => {
    /**
     * An advisory purl exactly as osv.dev exports it, and a component purl
     * exactly as syft writes it for the same package on the same distro. The
     * three families whose vendor the two sides spell differently, plus the
     * two whose exporter glues the qualifier onto the name.
     */
    const pairs: Array<[string, string, string]> = [
        [
            "pkg:rpm/rocky-linux/curl?distro=rocky-linux-8&epoch=0",
            "pkg:rpm/rocky/curl@7.61.1-33.el8?arch=x86_64&distro=rocky-8.9&upstream=curl-7.61.1-33.el8.src.rpm",
            "rpm/rocky-linux|curl",
        ],
        [
            "pkg:rpm/azure-linux/openssl",
            "pkg:rpm/azurelinux/openssl@3.3.7-4.azl3?arch=x86_64&distro=azurelinux-3.0&upstream=openssl-3.3.7-4.azl3.src.rpm",
            "rpm/azure-linux|openssl",
        ],
        [
            "pkg:rpm/suse/curl&distro=SUSE%20Linux%20Enterprise%20Server%2015%20SP7",
            "pkg:rpm/sles/curl@8.14.1-150700.7.20.1?arch=x86_64&distro=sles-15.7&upstream=curl-8.14.1-150700.7.20.1.src.rpm",
            "rpm/suse|curl",
        ],
    ];

    it.each(pairs)("%s ≡ %s", (advisory, component, key) => {
        expect(canonicalKeyForPurl(advisory)).toBe(key);
        expect(canonicalKeyForPurl(component)).toBe(key);
    });
});

describe("canonicalKey keeps distinct packages distinct", () => {
    /** Pairs that must never collide, with why they are tempting to fold. */
    const distinct: Array<[string, string, string]> = [
        [
            "pkg:golang/github.com/CosmWasm/wasmvm/v2",
            "pkg:golang/github.com/cosmwasm/wasmvm/v2",
            "Go module paths are case-sensitive",
        ],
        [
            "pkg:golang/github.com/CosmWasm/wasmvm/v2",
            "pkg:golang/github.com/CosmWasm/wasmvm",
            "the /vN suffix is part of the module identity",
        ],
        ["pkg:maven/com.example/MyLib", "pkg:maven/com.example/mylib", "Maven coordinates are case-sensitive"],
        [
            "pkg:rpm/redhat/openssl",
            "pkg:rpm/rocky/openssl",
            "OSV publishes Rocky as its own ecosystem; grype folds it into redhat",
        ],
        ["pkg:deb/debian/bash", "pkg:deb/ubuntu/bash", "Debian and Ubuntu advisories are not interchangeable"],
        ["pkg:npm/@angular/core", "pkg:npm/core", "the scope is part of the npm package name"],
        ["pkg:pypi/requests", "pkg:npm/requests", "the same name in two ecosystems is two packages"],
    ];

    it.each(distinct)("%s ≠ %s (%s)", (a, b) => {
        const keyA = canonicalKeyForPurl(a);
        const keyB = canonicalKeyForPurl(b);

        expect(keyA).not.toBeNull();
        expect(keyB).not.toBeNull();
        expect(keyA).not.toBe(keyB);
    });
});

// ===== The producer-spelling corpus =====

/**
 * One package, every legitimate PURL spelling of it, and the key all of them
 * must reach.
 *
 * The `syft 1.19.0` spellings are **real**, lifted verbatim from components in
 * the dev database — the same SBOMs the matcher runs against in production.
 * Syft up to 1.19.0 broke a Go module path after three segments and wrote the
 * remainder as the PURL subpath; 1.20 and later, and osv.dev's own exporter,
 * write the full path in the name. Both name the same module.
 *
 * The expected key is written out rather than derived from one of the
 * spellings, so the corpus states the module identity independently of any
 * producer's opinion about it. That is the invariant: the key is a function of
 * the package, not of who spelled it.
 */
const SPELLINGS: Array<{ module: string; key: string; spellings: string[] }> = [
    {
        // The origin of the whole bug: 16 false criticals on grafana/alloy.
        module: "github.com/grafana/pyroscope/api",
        key: "golang|github.com/grafana/pyroscope/api",
        spellings: [
            "pkg:golang/github.com/grafana/pyroscope/api@v1.2.0",
            "pkg:golang/github.com/grafana/pyroscope@v1.2.0#api",
        ],
    },
    {
        // A subpath carrying nothing but the major-version suffix.
        module: "github.com/go-resty/resty/v2",
        key: "golang|github.com/go-resty/resty/v2",
        spellings: [
            "pkg:golang/github.com/go-resty/resty/v2@v2.17.1",
            "pkg:golang/github.com/go-resty/resty@v2.17.1#v2",
        ],
    },
    {
        // A multi-segment subpath that *ends* in the version suffix.
        module: "go.etcd.io/etcd/client/pkg/v3",
        key: "golang|go.etcd.io/etcd/client/pkg/v3",
        spellings: [
            "pkg:golang/go.etcd.io/etcd/client/pkg/v3@v3.6.0",
            "pkg:golang/go.etcd.io/etcd/client@v3.6.0#pkg/v3",
        ],
    },
    {
        module: "github.com/apache/arrow/go/v12",
        key: "golang|github.com/apache/arrow/go/v12",
        spellings: [
            "pkg:golang/github.com/apache/arrow/go/v12@v12.0.1",
            "pkg:golang/github.com/apache/arrow@v12.0.1#go/v12",
        ],
    },
    {
        // Four subpath segments deep, on a module whose own name ends in -v2.
        module: "github.com/aws/aws-sdk-go-v2/service/internal/presigned-url",
        key: "golang|github.com/aws/aws-sdk-go-v2/service/internal/presigned-url",
        spellings: [
            "pkg:golang/github.com/aws/aws-sdk-go-v2/service/internal/presigned-url@v1.12.15",
            "pkg:golang/github.com/aws/aws-sdk-go-v2@v1.12.15#service/internal/presigned-url",
        ],
    },
    {
        // Not a github.com path — the three-segment split lands elsewhere.
        module: "cloud.google.com/go/compute/metadata",
        key: "golang|cloud.google.com/go/compute/metadata",
        spellings: [
            "pkg:golang/cloud.google.com/go/compute/metadata@v0.5.2",
            "pkg:golang/cloud.google.com/go/compute@v0.5.2#metadata",
        ],
    },
    {
        module: "google.golang.org/genproto/googleapis/api",
        key: "golang|google.golang.org/genproto/googleapis/api",
        spellings: [
            "pkg:golang/google.golang.org/genproto/googleapis/api@v0.0.0-20250303144028-a0af3efb3deb",
            "pkg:golang/google.golang.org/genproto/googleapis@v0.0.0-20250303144028-a0af3efb3deb#api",
        ],
    },
    {
        module: "buf.build/gen/go/parca-dev/parca/connectrpc/go",
        key: "golang|buf.build/gen/go/parca-dev/parca/connectrpc/go",
        spellings: [
            "pkg:golang/buf.build/gen/go/parca-dev/parca/connectrpc/go@v1.18.1-20250703125925-3f0fcf4bff96.1",
            "pkg:golang/buf.build/gen/go@v1.18.1-20250703125925-3f0fcf4bff96.1#parca-dev/parca/connectrpc/go",
        ],
    },
    {
        // Not Go. The npm scope is part of the name, and a producer may write
        // it percent-encoded or literally — the same class of disagreement.
        module: "@angular/core",
        key: "npm|@angular/core",
        spellings: ["pkg:npm/%40angular/core@16.0.0", "pkg:npm/@angular/core@16.0.0"],
    },
    {
        // Maven splits groupId from artifactId; OSV publishes them joined.
        module: "org.springframework:spring-core",
        key: "maven|org.springframework:spring-core",
        spellings: [
            "pkg:maven/org.springframework/spring-core@5.3.20",
            "pkg:maven/org.springframework/spring-core@5.3.20?type=jar",
        ],
    },
];

describe("canonicalKey is a function of the package, not of the producer", () => {
    it.each(SPELLINGS)("$module", ({ key, spellings }) => {
        // Stated separately from the equality below: two spellings agreeing on
        // a *wrong* key would satisfy "they match each other" and tell us
        // nothing about whether either matches the advisory side.
        for (const purl of spellings) {
            expect(canonicalKeyForPurl(purl), purl).toBe(key);
        }
    });

    it("covers both producers for every Go module in the corpus", () => {
        // A guard on the corpus itself. Delete the syft-1.19.0 half of an entry
        // and the assertion above still passes vacuously; this notices.
        const go = SPELLINGS.filter((s) => s.key.startsWith("golang|"));
        expect(go.length).toBeGreaterThanOrEqual(8);

        for (const { module, spellings } of go) {
            expect(
                spellings.some((p) => p.includes("#")),
                module,
            ).toBe(true);
            expect(
                spellings.some((p) => !p.includes("#")),
                module,
            ).toBe(true);
        }
    });
});

/**
 * The half that actually protects us.
 *
 * Folding the subpath back in is only correct if it stops *there*. A rule that
 * merged a submodule with its repository root would satisfy every positive
 * assertion above — one key per package — while re-creating the exact bug the
 * fold was written to remove.
 */
describe("canonicalKey keeps a Go submodule apart from what it is not", () => {
    const distinct: Array<[string, string, string]> = [
        [
            "pkg:golang/github.com/grafana/pyroscope@v1.2.0#api",
            "pkg:golang/github.com/grafana/pyroscope@v1.15.0",
            "a submodule is not its repository root — this pair was 16 false criticals",
        ],
        [
            "pkg:golang/go.etcd.io/etcd/client@v3.6.0#pkg/v3",
            "pkg:golang/go.etcd.io/etcd/client/v3@v3.6.0",
            "two submodules of one repository are two modules",
        ],
        [
            "pkg:golang/github.com/go-resty/resty@v2.17.1#v2",
            "pkg:golang/github.com/go-resty/resty@v1.12.0",
            "/vN is a different module from its v0/v1 predecessor",
        ],
        [
            "pkg:golang/github.com/apache/arrow@v12.0.1#go/v12",
            "pkg:golang/github.com/apache/arrow@v12.0.1",
            "a multi-segment subpath must not collapse either",
        ],
        [
            "pkg:golang/github.com/grafana/pyroscope@v1.2.0#api",
            "pkg:golang/github.com/grafana/pyroscope-go@v0.1.8#godeltaprof",
            "pyroscope and pyroscope-go are unrelated modules with similar names",
        ],
    ];

    it.each(distinct)("%s ≠ %s (%s)", (a, b) => {
        const keyA = canonicalKeyForPurl(a);
        const keyB = canonicalKeyForPurl(b);

        expect(keyA).not.toBeNull();
        expect(keyB).not.toBeNull();
        expect(keyA).not.toBe(keyB);
    });
});

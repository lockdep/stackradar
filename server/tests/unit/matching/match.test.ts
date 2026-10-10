/**
 * Orchestration: which lookups run, which candidates survive, and which row
 * wins when the same vulnerability is reachable two ways.
 *
 * Every test here runs against an in-memory `CandidateStore`, which is the
 * point of the port — release scoping, dedup, the upstream substitution and
 * the withdrawn guard are all properties of `match.ts` over a candidate list,
 * and none of them needs a database to state.
 *
 * Rows 1, 2, 3, 4, 7, 8, 9 and 20 of the plan's regression corpus live here.
 */

import { describe, expect, it } from "vitest";

import type { OsvRange } from "../../../src/db/schema/vulnerabilities.js";
import { createMatcher } from "../../../src/matching/match.js";
import type { VulnMatch } from "../../../src/matching/match.js";
import { createInMemoryCandidateStore } from "../../../src/matching/store.js";
import type { Candidate, CandidateKey, CandidateStore } from "../../../src/matching/store.js";

// ===== Fixtures =====

function candidate(overrides: Partial<Candidate> & Pick<Candidate, "matchKey">): Candidate {
    return {
        vulnerabilityId: "vuln-1",
        ecosystem: null,
        packageName: "pkg",
        versions: null,
        ranges: null,
        fixedVersion: null,
        withdrawn: false,
        ...overrides,
    };
}

/** `introduced: 0` up to (but excluding) `fixed`. */
function fixedIn(fixed: string): OsvRange[] {
    return [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed }] }];
}

function between(introduced: string, fixed: string): OsvRange[] {
    return [{ type: "ECOSYSTEM", events: [{ introduced }, { fixed }] }];
}

/** A store that reports how often it was asked, and for what. */
function countingStore(candidates: readonly Candidate[]): CandidateStore & {
    calls: number;
    keysAsked: string[];
} {
    const inner = createInMemoryCandidateStore(candidates);
    const spy = {
        calls: 0,
        keysAsked: [] as string[],
        async findByKeys(keys: readonly CandidateKey[]) {
            spy.calls++;
            spy.keysAsked.push(...keys.map((k) => k.key));
            return inner.findByKeys(keys);
        },
    };
    return spy;
}

function matcherOver(candidates: readonly Candidate[]) {
    return createMatcher(createInMemoryCandidateStore(candidates));
}

// ===== Tests =====

describe("createMatcher() — components the matcher cannot look up", () => {
    it("returns nothing for a component with no PURL", async () => {
        const store = countingStore([candidate({ matchKey: "npm|lodash" })]);
        const matcher = createMatcher(store);

        expect(await matcher.findVulnerabilities({ name: "lodash", version: "4.17.20" })).toEqual(
            []
        );
        expect(store.calls).toBe(0);
    });

    it("returns nothing for a PURL that will not parse", async () => {
        const store = countingStore([candidate({ matchKey: "npm|lodash" })]);
        const matcher = createMatcher(store);

        const matches = await matcher.findVulnerabilities({
            purl: "not-a-purl",
            name: "lodash",
            version: "4.17.20",
        });

        expect(matches).toEqual([]);
        expect(store.calls).toBe(0);
    });
});

describe("createMatcher() — the basic match", () => {
    it("matches on the canonical key and reports the candidate's metadata", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-lodash",
                matchKey: "npm|lodash",
                ecosystem: "npm",
                packageName: "lodash",
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
                fixedVersion: "4.17.21",
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:npm/lodash@4.17.20",
            name: "lodash",
            version: "4.17.20",
        });

        expect(matches).toEqual<VulnMatch[]>([
            {
                vulnerabilityId: "vuln-lodash",
                matchType: "direct",
                matchedBy: "purl",
                confidence: "exact",
                fixedVersion: "4.17.21",
                ecosystem: "npm",
                packageName: "lodash",
            },
        ]);
    });

    it("normalizes the component side onto the advisory's key (corpus row 17)", async () => {
        const matcher = matcherOver([
            candidate({ matchKey: "pypi|zope-interface", ecosystem: "PyPI" }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:pypi/Zope_Interface@5.0",
            name: "Zope_Interface",
            version: "5.0",
        });

        expect(matches).toHaveLength(1);
    });

    it("drops a candidate whose version is confirmed not affected", async () => {
        const matcher = matcherOver([
            candidate({
                matchKey: "npm|lodash",
                ecosystem: "npm",
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:npm/lodash@4.17.21",
            name: "lodash",
            version: "4.17.21",
        });

        expect(matches).toEqual([]);
    });

    it("keeps an unanswerable *advisory* bound as an unconfirmed match", async () => {
        // The question was asked and the advisory could not answer it. The
        // component states a real version; the record states a blank bound,
        // which `compare` refuses to order rather than guess at. That
        // uncertainty is real evidence about the advisory, and dropping it
        // would be a false negative with no paper trail — which is the
        // distinction the next test is the other half of.
        const matcher = matcherOver([
            candidate({
                matchKey: "npm|lodash",
                ecosystem: "npm",
                ranges: [{ type: "SEMVER", events: [{ introduced: " " }] }],
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:npm/lodash@4.17.20",
            name: "lodash",
            version: "4.17.20",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.confidence).toBe("unconfirmed");
    });

    it("asks nothing at all for a component with no usable version", async () => {
        // The other half of the rule. `unknown` is what a scanner writes when
        // it cannot read a version out of a binary; there is no question to
        // leave open, so no row is produced. See `hasAnswerableVersion`.
        const matcher = matcherOver([
            candidate({
                matchKey: "npm|lodash",
                ecosystem: "npm",
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
            }),
        ]);

        for (const version of ["unknown", "UNKNOWN", "", null]) {
            const matches = await matcher.findVulnerabilities({
                purl: "pkg:npm/lodash",
                name: "lodash",
                version,
            });
            expect(matches, JSON.stringify(version)).toEqual([]);
        }
    });
});

describe("createMatcher() — the Go stdlib (§3.1)", () => {
    /**
     * Syft records the Go standard library as `pkg:golang/stdlib@go1.24.1`. The
     * canonical key was always right — `golang|stdlib` is what OSV publishes
     * against — so the whole failure lived in the comparator: `go1.24.1` parsed
     * to no numeric components, sorted below every bound, and the match was
     * dropped as a confirmed miss rather than surfaced at all.
     */
    const stdlibAdvisory = candidate({
        vulnerabilityId: "vuln-go-stdlib",
        matchKey: "golang|stdlib",
        ecosystem: "Go",
        packageName: "stdlib",
        ranges: [{ type: "SEMVER", events: [{ introduced: "1.24.0" }, { fixed: "1.24.2" }] }],
        fixedVersion: "1.24.2",
    });

    it("matches a go-prefixed stdlib version exactly", async () => {
        const matches = await matcherOver([stdlibAdvisory]).findVulnerabilities({
            purl: "pkg:golang/stdlib@go1.24.1",
            name: "stdlib",
            version: "go1.24.1",
        });

        expect(matches).toEqual<VulnMatch[]>([
            {
                vulnerabilityId: "vuln-go-stdlib",
                matchType: "direct",
                matchedBy: "purl",
                confidence: "exact",
                fixedVersion: "1.24.2",
                ecosystem: "Go",
                packageName: "stdlib",
            },
        ]);
    });

    it("agrees with the same version spelled without the prefix", async () => {
        const matcher = matcherOver([stdlibAdvisory]);

        const prefixed = await matcher.findVulnerabilities({
            purl: "pkg:golang/stdlib@go1.24.1",
            name: "stdlib",
            version: "go1.24.1",
        });
        const plain = await matcher.findVulnerabilities({
            purl: "pkg:golang/stdlib@1.24.1",
            name: "stdlib",
            version: "1.24.1",
        });

        expect(prefixed).toEqual(plain);
    });

    it("still drops a stdlib version the advisory does not cover", async () => {
        // The fix must not turn into "everything Go matches": `go1.24.2` is the
        // fixed release, and `go1.23.9` predates the range entirely.
        const matcher = matcherOver([stdlibAdvisory]);

        for (const version of ["go1.24.2", "go1.23.9"]) {
            const matches = await matcher.findVulnerabilities({
                purl: `pkg:golang/stdlib@${version}`,
                name: "stdlib",
                version,
            });
            expect(matches, version).toEqual([]);
        }
    });

    it("drops a development build rather than reporting it unconfirmed", async () => {
        // `(devel)` is Go's placeholder for a binary built outside a module —
        // definitionally not a version, so every candidate for the package
        // would come back unconfirmed no matter what its bounds say. grype
        // skips the same class (`grype/matcher/golang/matcher.go:59`).
        const matches = await matcherOver([stdlibAdvisory]).findVulnerabilities({
            purl: "pkg:golang/stdlib@(devel)",
            name: "stdlib",
            version: "(devel)",
        });

        expect(matches).toEqual([]);
    });

    it("still asks the indirect question when only the component version is missing", async () => {
        // The rule is per pass, not per component. A binary package that
        // cannot state its own version but names the source package it was
        // built from — and the version that source package had — still has an
        // answerable question, and still gets asked it.
        const matcher = matcherOver([
            candidate({
                matchKey: "apk/alpine|openssl",
                ecosystem: "Alpine:v3.23",
                ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "3.6.0-r0" }] }],
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/libcrypto3?distro=alpine-3.23.3&upstream=openssl%403.5.5-r0",
            name: "libcrypto3",
            version: "unknown",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.matchType).toBe("indirect");
        expect(matches[0]?.confidence).toBe("exact");
    });
});

describe("createMatcher() — withdrawn advisories (corpus row 1)", () => {
    /**
     * The store already filters these out in SQL. This asserts the *second*
     * guard, the one that does not depend on any store implementation getting
     * its predicate right — so the store here deliberately hands back a
     * withdrawn row.
     */
    it("never reports a withdrawn advisory, even if the store returns one", async () => {
        const withdrawnRow = candidate({
            matchKey: "npm|lodash",
            ecosystem: "npm",
            withdrawn: true,
        });

        const leakyStore: CandidateStore = {
            findByKeys: (keys) =>
                Promise.resolve(
                    new Map(keys.map(({ key }) => [key, [{ ...withdrawnRow, matchKey: key }]]))
                ),
        };

        const matches = await createMatcher(leakyStore).findVulnerabilities({
            purl: "pkg:npm/lodash@4.17.20",
            name: "lodash",
            version: "4.17.20",
        });

        expect(matches).toEqual([]);
    });
});

describe("createMatcher() — release scoping", () => {
    /**
     * Corpus row 2: a 2016 Alpine 3.4 advisory must not reach an Alpine 3.23
     * package. The range is left deliberately open-ended so that scoping is the
     * only thing that can exclude it — a narrower range would let this pass on
     * the version check and say nothing about release scoping at all.
     */
    it("excludes advisories from another distro release", async () => {
        const matcher = matcherOver([
            candidate({
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.4",
                packageName: "curl",
                ranges: fixedIn("99.0-r0"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/curl@8.17.0-r1?arch=x86_64&distro=alpine-3.23.3",
            name: "curl",
            version: "8.17.0-r1",
        });

        expect(matches).toEqual([]);
    });

    /** Corpus row 3: the advisory's release must be a dot-boundary prefix, not an equal token. */
    it("matches a RHEL 8 advisory against a RHEL 8.10 component", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-openssl",
                matchKey: "rpm/redhat|openssl",
                ecosystem: "Red Hat:enterprise_linux:8::appstream",
                packageName: "openssl",
                ranges: fixedIn("1:3.0.7-25.el8"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:rpm/redhat/openssl@3.0.7-24?distro=rhel-8.10",
            name: "openssl",
            version: "3.0.7-24",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.confidence).toBe("exact");
    });

    it("does not treat 8 as a prefix of 18.04", async () => {
        const matcher = matcherOver([
            candidate({
                matchKey: "deb/ubuntu|bash",
                ecosystem: "Debian:8",
                ranges: fixedIn("99.0"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:deb/ubuntu/bash@5.1-6ubuntu1?distro=ubuntu-18.04",
            name: "bash",
            version: "5.1-6ubuntu1",
        });

        expect(matches).toEqual([]);
    });

    /**
     * Corpus row 4. The old matcher fell back to the *entire* unscoped
     * candidate set whenever scoping matched nothing, which re-admitted every
     * other release's advisories. Removing that fallback is only safe because
     * suffix-less advisories survive scoping on their own — so this test and
     * the one above it have to hold at the same time.
     */
    it("keeps suffix-less advisories for a distro it has no release mapping for", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-scoped",
                matchKey: "rpm/exoticos|openssl",
                ecosystem: "Red Hat:enterprise_linux:8::appstream",
                ranges: fixedIn("99.0"),
            }),
            candidate({
                vulnerabilityId: "vuln-family-wide",
                matchKey: "rpm/exoticos|openssl",
                ecosystem: "Red Hat",
                ranges: fixedIn("99.0"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:rpm/exoticos/openssl@3.0.7-24?distro=exoticos-42",
            name: "openssl",
            version: "3.0.7-24",
        });

        expect(matches.map((m) => m.vulnerabilityId)).toEqual(["vuln-family-wide"]);
    });

    it("scopes per component, not per lookup", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-3.4",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.4",
                ranges: fixedIn("99.0-r0"),
            }),
            candidate({
                vulnerabilityId: "vuln-3.23",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
                ranges: fixedIn("99.0-r0"),
            }),
        ]);

        const results = await matcher.findVulnerabilitiesBatch([
            {
                id: "old",
                purl: "pkg:apk/alpine/curl@7.49.0-r0?distro=alpine-3.4.6",
                name: "curl",
                version: "7.49.0-r0",
            },
            {
                id: "new",
                purl: "pkg:apk/alpine/curl@8.17.0-r1?distro=alpine-3.23.3",
                name: "curl",
                version: "8.17.0-r1",
            },
        ]);

        expect(results.get("old")?.map((m) => m.vulnerabilityId)).toEqual(["vuln-3.4"]);
        expect(results.get("new")?.map((m) => m.vulnerabilityId)).toEqual(["vuln-3.23"]);
    });

    /**
     * §3.2 / W3. Our own agent always writes `distro=`; imported SBOMs often do
     * not. A base PURL like `pkg:apk/alpine/curl` is identical across every
     * Alpine branch ever released, so admitting all of them re-creates exactly
     * the corpus-row-2 failure the scoping was written to kill — the difference
     * being that here the component, not the advisory, is the one withholding.
     *
     * The release-less advisory is what keeps this from being grype's harsher
     * "no distro ⇒ no matches at all".
     */
    it("admits only release-less advisories for an apk component with no distro=", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-3.4",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.4",
                ranges: fixedIn("99.0-r0"),
            }),
            candidate({
                vulnerabilityId: "vuln-3.23",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
                ranges: fixedIn("99.0-r0"),
            }),
            candidate({
                vulnerabilityId: "vuln-family-wide",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine",
                ranges: fixedIn("99.0-r0"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/curl@8.17.0-r1",
            name: "curl",
            version: "8.17.0-r1",
        });

        expect(matches.map((m) => m.vulnerabilityId)).toEqual(["vuln-family-wide"]);
    });

    /**
     * The same component *with* the qualifier: proof that the rule above is
     * about missing information rather than about apk components in general.
     */
    it("still scopes to the named branch when the apk component does say distro=", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-3.4",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.4",
                ranges: fixedIn("99.0-r0"),
            }),
            candidate({
                vulnerabilityId: "vuln-3.23",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
                ranges: fixedIn("99.0-r0"),
            }),
            candidate({
                vulnerabilityId: "vuln-family-wide",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine",
                ranges: fixedIn("99.0-r0"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/curl@8.17.0-r1?distro=alpine-3.23.3",
            name: "curl",
            version: "8.17.0-r1",
        });

        expect(matches.map((m) => m.vulnerabilityId).sort()).toEqual([
            "vuln-3.23",
            "vuln-family-wide",
        ]);
    });

    /**
     * The other half of the type-aware rule: an npm package has no distro and
     * never will, so a release-bearing advisory in a language ecosystem must
     * still reach it. (OSV writes these for repository-scoped ecosystems such
     * as Packagist's Drupal repository, where the suffix is not a release.)
     */
    it("does not scope a language-ecosystem component out for lack of a distro", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-drupal",
                matchKey: "composer|drupal/core",
                ecosystem: "Packagist:https://packages.drupal.org/8",
                packageName: "drupal/core",
                ranges: fixedIn("99.0.0"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:composer/drupal/core@10.1.0",
            name: "drupal/core",
            version: "10.1.0",
        });

        expect(matches.map((m) => m.vulnerabilityId)).toEqual(["vuln-drupal"]);
    });
});

describe("createMatcher() — the upstream pass", () => {
    it("finds an advisory published against the source package", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-openssl",
                matchKey: "apk/alpine|openssl",
                ecosystem: "Alpine:v3.23",
                packageName: "openssl",
                ranges: fixedIn("3.5.6-r0"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/libcrypto3@3.5.5-r0?distro=alpine-3.23.3&upstream=openssl",
            name: "libcrypto3",
            version: "3.5.5-r0",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.matchType).toBe("indirect");
        expect(matches[0]?.upstream).toEqual({ name: "openssl", version: "3.5.5-r0" });
    });

    /**
     * Corpus row 7. A source advisory is written against source versions, so
     * checking it against the binary package's own version compares two
     * different things — here the binary's rebuild revision (`-3ubuntu1`) sits
     * above the fix while the source version it was built from (`-1`) sits
     * below it.
     */
    it("range-checks with the upstream's version, not the binary's", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-foo",
                matchKey: "deb/ubuntu|foo",
                ecosystem: "Ubuntu:22.04:LTS",
                packageName: "foo",
                ranges: fixedIn("2.4.1-2"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:deb/ubuntu/libfoo@2.4.1-3ubuntu1?distro=ubuntu-22.04&upstream=foo@2.4.1-1",
            name: "libfoo",
            version: "2.4.1-3ubuntu1",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.matchType).toBe("indirect");
        expect(matches[0]?.upstream).toEqual({ name: "foo", version: "2.4.1-1" });
        expect(matches[0]?.confidence).toBe("exact");
    });

    /**
     * Corpus row 8. The qualifier is a source-RPM *filename*, and the advisory
     * bounds carry epoch `4:` while the filename carries none. Zero-filling the
     * missing epoch would put the component below `4:5.26.3-400.el8` and the
     * advisory would never be introduced at all — so this range is chosen to
     * fail under that reading and pass under the correct one.
     */
    it("parses a source-RPM filename and does not zero-fill its epoch", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-perl",
                matchKey: "rpm/redhat|perl",
                ecosystem: "Red Hat:enterprise_linux:8::appstream",
                packageName: "perl",
                ranges: between("4:5.26.3-400.el8", "4:5.26.3-420.el8"),
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:rpm/redhat/perl-Errno@1.28-419.el8_4.1?distro=rhel-8.4&upstream=perl-5.26.3-419.el8_4.1.src.rpm",
            name: "perl-Errno",
            version: "1.28-419.el8_4.1",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.matchType).toBe("indirect");
        expect(matches[0]?.upstream).toEqual({ name: "perl", version: "5.26.3-419.el8_4.1" });
        expect(matches[0]?.confidence).toBe("exact");
    });

    it("does not run a second pass when the upstream is the package itself", async () => {
        const store = countingStore([
            candidate({
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
                ranges: fixedIn("99.0-r0"),
            }),
        ]);

        const matches = await createMatcher(store).findVulnerabilities({
            purl: "pkg:apk/alpine/curl@8.17.0-r1?distro=alpine-3.23.3&upstream=curl",
            name: "curl",
            version: "8.17.0-r1",
        });

        expect(store.keysAsked).toEqual(["apk/alpine|curl"]);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.matchType).toBe("direct");
        expect(matches[0]?.upstream).toBeUndefined();
    });
});

describe("createMatcher() — reducing to one row per vulnerability", () => {
    /** Corpus row 20. */
    it("prefers the direct match when a vulnerability is reachable both ways", async () => {
        const shared = {
            vulnerabilityId: "vuln-shared",
            ecosystem: "Alpine:v3.23",
            ranges: fixedIn("99.0-r0"),
        };

        const matcher = matcherOver([
            candidate({ ...shared, matchKey: "apk/alpine|libcrypto3", packageName: "libcrypto3" }),
            candidate({ ...shared, matchKey: "apk/alpine|openssl", packageName: "openssl" }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/libcrypto3@3.5.5-r0?distro=alpine-3.23.3&upstream=openssl",
            name: "libcrypto3",
            version: "3.5.5-r0",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.matchType).toBe("direct");
        expect(matches[0]?.packageName).toBe("libcrypto3");
    });

    it("prefers the firmer verdict among candidates of the same kind", async () => {
        const matcher = matcherOver([
            // Same vulnerability, two affected[] entries: one leaves the
            // version question open, the other answers it.
            candidate({
                vulnerabilityId: "vuln-shared",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
            }),
            candidate({
                vulnerabilityId: "vuln-shared",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
                ranges: fixedIn("99.0-r0"),
                fixedVersion: "99.0-r0",
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/curl@8.17.0-r1?distro=alpine-3.23.3",
            name: "curl",
            version: "8.17.0-r1",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.confidence).toBe("exact");
        expect(matches[0]?.fixedVersion).toBe("99.0-r0");
    });

    it("does not let a later unconfirmed candidate downgrade a confirmed one", async () => {
        const matcher = matcherOver([
            candidate({
                vulnerabilityId: "vuln-shared",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
                ranges: fixedIn("99.0-r0"),
            }),
            candidate({
                vulnerabilityId: "vuln-shared",
                matchKey: "apk/alpine|curl",
                ecosystem: "Alpine:v3.23",
            }),
        ]);

        const matches = await matcher.findVulnerabilities({
            purl: "pkg:apk/alpine/curl@8.17.0-r1?distro=alpine-3.23.3",
            name: "curl",
            version: "8.17.0-r1",
        });

        expect(matches).toHaveLength(1);
        expect(matches[0]?.confidence).toBe("exact");
    });
});

describe("createMatcher() — the batch path", () => {
    it("asks the store once for every component in the batch", async () => {
        const store = countingStore([
            candidate({ vulnerabilityId: "vuln-a", matchKey: "npm|lodash", ecosystem: "npm" }),
            candidate({ vulnerabilityId: "vuln-b", matchKey: "pypi|requests", ecosystem: "PyPI" }),
        ]);

        const results = await createMatcher(store).findVulnerabilitiesBatch([
            { id: "c1", purl: "pkg:npm/lodash@4.17.20", name: "lodash", version: "4.17.20" },
            { id: "c2", purl: "pkg:pypi/requests@2.0.0", name: "requests", version: "2.0.0" },
            { id: "c3", purl: "pkg:npm/lodash@4.17.19", name: "lodash", version: "4.17.19" },
        ]);

        expect(store.calls).toBe(1);
        expect(new Set(store.keysAsked)).toEqual(new Set(["npm|lodash", "pypi|requests"]));
        expect(results.get("c1")?.map((m) => m.vulnerabilityId)).toEqual(["vuln-a"]);
        expect(results.get("c2")?.map((m) => m.vulnerabilityId)).toEqual(["vuln-b"]);
        expect(results.get("c3")?.map((m) => m.vulnerabilityId)).toEqual(["vuln-a"]);
    });

    it("gives every input an entry, including components it cannot look up", async () => {
        const store = countingStore([]);

        const results = await createMatcher(store).findVulnerabilitiesBatch([
            { id: "c1", name: "mystery", version: "1.0.0" },
            { id: "c2", purl: "pkg:npm/lodash@4.17.20", name: "lodash", version: "4.17.20" },
        ]);

        expect([...results.keys()].sort()).toEqual(["c1", "c2"]);
        expect(results.get("c1")).toEqual([]);
        expect(results.get("c2")).toEqual([]);
    });

    it("never touches the store when no component is matchable", async () => {
        const store = countingStore([candidate({ matchKey: "npm|lodash" })]);

        await createMatcher(store).findVulnerabilitiesBatch([
            { id: "c1", name: "mystery", version: "1.0.0" },
        ]);

        expect(store.calls).toBe(0);
    });

    it("returns an empty map for an empty batch", async () => {
        const results = await matcherOver([]).findVulnerabilitiesBatch([]);
        expect(results.size).toBe(0);
    });
});

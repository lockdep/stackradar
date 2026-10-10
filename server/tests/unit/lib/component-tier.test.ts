/**
 * The component-tier classifier. Pure, so this table is the contract — one
 * line per rule, plus the traps that must NOT match. The Go CLI ports the
 * same table (plan item 10); change both together.
 */

import { describe, it, expect } from "vitest";
import {
    classifyComponent,
    classifyFromProperties,
    type ClassifyInput,
    type Tier,
} from "../../../src/lib/component-tier.js";

const TABLE: Array<[label: string, input: ClassifyInput, expected: Tier]> = [
    // Rule 1
    ["apk package", { packageType: "apk", name: "libssl3", path: "/lib/apk/db/installed" }, "os"],
    ["deb package", { packageType: "deb", name: "libc6", path: "/var/lib/dpkg/status" }, "os"],
    ["rpm package", { packageType: "rpm", name: "glibc", path: "/var/lib/rpm/rpmdb.sqlite" }, "os"],
    ["alpm package", { packageType: "alpm", name: "pacman" }, "os"],
    ["portage package", { packageType: "portage", name: "sys-libs/glibc" }, "os"],
    ["nix package", { packageType: "nix", name: "openssl" }, "os"],
    // Rule 2
    ["binary cataloger hit", { packageType: "binary", name: "node", path: "/usr/local/bin/node" }, "runtime"],
    // Rule 3
    [
        "node's bundled npm",
        { packageType: "npm", name: "semver", path: "/usr/local/lib/node_modules/npm/node_modules/semver/package.json" },
        "runtime",
    ],
    ["distro node_modules", { packageType: "npm", name: "npm", path: "/usr/lib/node_modules/npm/package.json" }, "runtime"],
    ["yarn", { packageType: "npm", name: "yarn", path: "/opt/yarn-v1.22.22/package.json" }, "runtime"],
    ["corepack", { packageType: "npm", name: "corepack", path: "/usr/local/lib/corepack/package.json" }, "runtime"],
    // Rule 4
    ["pip", { packageType: "python", name: "pip", path: "/usr/local/lib/python3.12/site-packages/pip-24.0.dist-info/METADATA" }, "runtime"],
    ["setuptools", { packageType: "python", name: "setuptools" }, "runtime"],
    ["wheel", { packageType: "python", name: "wheel" }, "runtime"],
    // Rule 5
    ["JDK jar", { packageType: "java-archive", name: "jrt-fs", path: "/usr/lib/jvm/java-21/lib/jrt-fs.jar" }, "runtime"],
    ["temurin jar", { packageType: "java-archive", name: "jrt-fs", path: "/opt/java/openjdk/lib/jrt-fs.jar" }, "runtime"],
    // Rule 6
    [
        "ruby default gem",
        { packageType: "gem", name: "rexml", path: "/usr/local/lib/ruby/gems/3.3.0/specifications/rexml-3.2.6.gemspec" },
        "runtime",
    ],
    // Rule 7
    [
        "go main module",
        { packageType: "go-module", name: "github.com/stefanprodan/podinfo", path: "/home/app/podinfo", mainModule: "github.com/stefanprodan/podinfo" },
        "main",
    ],
    // Rule 8
    ["maven dependency", { packageType: "java-archive", name: "log4j-core", path: "/app/lib/log4j-core-2.17.1.jar" }, "application"],
    ["python dependency", { packageType: "python", name: "requests", path: "/usr/local/lib/python3.12/site-packages/requests-2.31.0.dist-info/METADATA" }, "application"],
    // Rule 9
    ["no package type", { packageType: null, name: "/etc/passwd" }, "unknown"],

    // Traps — must NOT match the rule above them.
    ["TRAP npm under /app", { packageType: "npm", name: "lodash", path: "/app/node_modules/lodash/package.json" }, "application"],
    ["TRAP deb python3-requests", { packageType: "deb", name: "python3-requests", path: "/var/lib/dpkg/status" }, "os"],
    [
        "TRAP go dependency, not main",
        { packageType: "go-module", name: "golang.org/x/net", path: "/home/app/podinfo", mainModule: "github.com/stefanprodan/podinfo" },
        "application",
    ],
    [
        "TRAP Gemfile gem beside default gems",
        { packageType: "gem", name: "rails", path: "/usr/local/lib/ruby/gems/3.3.0/specifications/rails-7.1.0.gemspec" },
        "application",
    ],
    ["TRAP application jar outside the JVM", { packageType: "java-archive", name: "spring-core", path: "/opt/app/spring-core.jar" }, "application"],
];

describe("classifyComponent", () => {
    it.each(TABLE)("%s", (_label, input, expected) => {
        expect(classifyComponent(input)).toBe(expected);
    });
});

describe("classifyFromProperties", () => {
    it("reads the three syft properties out of a raw property list", () => {
        const tier = classifyFromProperties({ name: "semver" }, [
            { name: "syft:package:language", value: "javascript" },
            { name: "syft:package:type", value: "npm" },
            { name: "syft:location:0:layerID", value: "sha256:abc" },
            { name: "syft:location:0:path", value: "/usr/local/lib/node_modules/npm/node_modules/semver/package.json" },
        ]);
        expect(tier).toBe("runtime");
    });

    it("is unknown for a component with no properties", () => {
        expect(classifyFromProperties({ name: "thing" }, [])).toBe("unknown");
    });
});

describe("applyTierRules — an org's own answer, after the built-in rules", () => {
    const rules = [
        { matchKind: "purl-prefix" as const, pattern: "pkg:npm/@mycorp/", tier: "application" as const },
        { matchKind: "purl-prefix" as const, pattern: "pkg:npm/@mycorp/vendored-", tier: "runtime" as const },
        { matchKind: "path-prefix" as const, pattern: "/opt/vendor/", tier: "os" as const },
        { matchKind: "name" as const, pattern: "pkg:npm/@mycorp/", tier: "main" as const },
    ];

    it("overrides the built-in verdict for what it matches, and nothing else", async () => {
        const { applyTierRules } = await import("../../../src/lib/component-tier.js");
        expect(applyTierRules("runtime", { name: "@mycorp/cli", purl: "pkg:npm/@mycorp/cli@1.0.0" }, rules)).toBe("application");
        expect(applyTierRules("application", { name: "left-pad", purl: "pkg:npm/left-pad@1.0.0", path: "/opt/vendor/x/package.json" }, rules)).toBe("os");
        expect(applyTierRules("application", { name: "lodash", purl: "pkg:npm/lodash@4.17.21" }, rules)).toBe("application");
        expect(applyTierRules("os", { name: "libc6", purl: null, path: null }, rules)).toBe("os");
    });

    it("lets the most specific rule win: the longest prefix, and an exact name before any prefix", async () => {
        const { applyTierRules } = await import("../../../src/lib/component-tier.js");
        expect(applyTierRules("application", { name: "@mycorp/vendored-zlib", purl: "pkg:npm/@mycorp/vendored-zlib@1.0.0" }, rules)).toBe("runtime");
        expect(applyTierRules("application", { name: "pkg:npm/@mycorp/", purl: "pkg:npm/@mycorp/x@1" }, rules)).toBe("main");
    });

    it("treats a pattern literally — no wildcards to get wrong", async () => {
        const { applyTierRules } = await import("../../../src/lib/component-tier.js");
        const literal = [{ matchKind: "purl-prefix" as const, pattern: "pkg:npm/%", tier: "os" as const }];
        expect(applyTierRules("application", { name: "lodash", purl: "pkg:npm/lodash@1" }, literal)).toBe("application");
    });
});

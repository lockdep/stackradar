/**
 * What kind of thing a component is — the `components.tier` column.
 *
 * A tier is a default lens, never a verdict: it decides what a findings table
 * shows first, not what exists. The level belongs to the *occurrence*, not the
 * package — the same npm package is `application` under `/app/node_modules`
 * and `runtime` inside node's own bundled npm — which is why this is computed
 * per component row, from the properties syft wrote for that row.
 *
 * Pure, no I/O. The ingest path (`sbom.service.ts`) and the backfill
 * (`scripts/backfill-component-tier.ts`) both call it, so a rule change is a
 * `TIER_VERSION` bump plus a backfill run, never a rescan. The Go CLI carries
 * a port of this table with the same fixtures (plan item 10).
 *
 * See docs/component-tier-plan-2026-09-13.md § Classifier rules.
 */

/** Bump on any rule change; the backfill re-classifies rows below it. */
export const TIER_VERSION = 1;

export const TIERS = ["os", "runtime", "application", "main", "unknown"] as const;
export type Tier = (typeof TIERS)[number];

export interface ClassifyInput {
    /** `syft:package:type` — apk, deb, npm, go-module, binary… */
    packageType: string | null | undefined;
    name: string;
    /** `syft:location:0:path` */
    path?: string | null | undefined;
    /** `syft:metadata:mainModule` — on every go-module of a binary, the module path of that binary's main module. */
    mainModule?: string | null | undefined;
}

const OS_PACKAGE_TYPES = new Set(["apk", "deb", "rpm", "alpm", "portage", "nix"]);

const NODE_RUNTIME_PREFIXES = [
    "/usr/local/lib/node_modules/",
    "/usr/lib/node_modules/",
    "/opt/yarn",
    "/usr/local/lib/corepack",
];

const PYTHON_TOOLING = new Set(["pip", "setuptools", "wheel"]);

const JVM_PREFIXES = ["/usr/lib/jvm/", "/opt/java/"];

/**
 * Ruby default gems — shipped inside the interpreter, not added by a Gemfile.
 * Source: https://stdgems.org/ (default + bundled gems, Ruby 3.3), trimmed to
 * the ones that have ever carried an advisory or that every ruby image lists.
 */
const RUBY_DEFAULT_GEMS = new Set([
    "abbrev", "base64", "benchmark", "bigdecimal", "bundler", "cgi", "csv", "date",
    "debug", "delegate", "did_you_mean", "digest", "drb", "english", "erb",
    "error_highlight", "etc", "fcntl", "fiddle", "fileutils", "find", "forwardable",
    "getoptlong", "io-console", "io-nonblock", "io-wait", "ipaddr", "irb", "json",
    "logger", "matrix", "minitest", "mutex_m", "net-ftp", "net-http", "net-imap",
    "net-pop", "net-protocol", "net-smtp", "nkf", "observer", "open-uri", "open3",
    "openssl", "optparse", "ostruct", "pathname", "power_assert", "pp",
    "prettyprint", "prime", "pstore", "psych", "racc", "rake", "rbs", "rdoc",
    "readline", "readline-ext", "reline", "resolv", "resolv-replace", "rexml",
    "rinda", "rss", "ruby2_keywords", "securerandom", "set", "shellwords",
    "singleton", "stringio", "strscan", "syntax_suggest", "syslog", "tempfile",
    "test-unit", "time", "timeout", "tmpdir", "tsort", "typeprof", "un", "uri",
    "weakref", "webrick", "yaml", "zlib",
]);

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
    return prefixes.some((p) => path.startsWith(p));
}

/** First match wins. Each rule names the noise it exists for. */
export function classifyComponent(input: ClassifyInput): Tier {
    const type = input.packageType?.toLowerCase() ?? null;
    const path = input.path ?? "";
    const name = input.name.toLowerCase();

    // 9. No package type at all: syft's `file` entries, the distro component,
    //    hand-written SBOMs. None of them can carry a finding the lens would hide.
    if (type === null || type === "") return "unknown";

    // 1. Distro packages: libssl, glibc, the kernel headers — the 1,000-finding bucket.
    if (OS_PACKAGE_TYPES.has(type)) return "os";

    // 2. syft's binary cataloger: the node / python / go / openssl / busybox
    //    executables the base image ships.
    if (type === "binary") return "runtime";

    // 3. node's bundled npm, yarn and corepack — the loudest false
    //    "application" noise in every node image.
    if (type === "npm" && startsWithAny(path, NODE_RUNTIME_PREFIXES)) return "runtime";

    // 4. pip / setuptools / wheel: installed by the python base image, never by
    //    a requirements.txt. (Debian's python3-* are deb, so rule 1 has them.)
    if (type === "python" && PYTHON_TOOLING.has(name)) return "runtime";

    // 5. The JDK's own jars.
    if (type === "java-archive" && startsWithAny(path, JVM_PREFIXES)) return "runtime";

    // 6. Gems that ship inside the ruby interpreter.
    if (type === "gem" && path.includes("/lib/ruby/gems/") && RUBY_DEFAULT_GEMS.has(name)) {
        return "runtime";
    }

    // 7. The Go binary's own main module — the application itself.
    if (type === "go-module" && input.mainModule && input.mainModule === input.name) {
        return "main";
    }

    // 8. A dependency the build added and the customer can bump.
    return "application";
}

// ─── Org override rules (plan item 9) ──────────────────────────────────────

export const TIER_RULE_KINDS = ["purl-prefix", "name", "path-prefix"] as const;
export type TierRuleKind = (typeof TIER_RULE_KINDS)[number];

/** A tier an org may assign. `unknown` is the absence of an answer, not one. */
export const ASSIGNABLE_TIERS = ["application", "main", "os", "runtime"] as const;
export type AssignableTier = (typeof ASSIGNABLE_TIERS)[number];

export interface TierRule {
    matchKind: TierRuleKind;
    /** Compared case-sensitively and literally: a prefix, or for `name` the whole name. No wildcards. */
    pattern: string;
    tier: AssignableTier;
}

function ruleMatches(rule: TierRule, component: { name: string; purl?: string | null; path?: string | null }): boolean {
    switch (rule.matchKind) {
        case "purl-prefix":
            return component.purl != null && component.purl.startsWith(rule.pattern);
        case "name":
            return component.name === rule.pattern;
        case "path-prefix":
            return component.path != null && component.path.startsWith(rule.pattern);
    }
}

/**
 * An org's own answer, applied **after** the built-in rules: "everything
 * under `pkg:npm/@mycorp/` is our application", "`/opt/vendor/` is the base
 * image's". The most specific matching rule wins — the longest pattern, an
 * exact name before any prefix — so a narrow exception can sit beside a broad
 * rule. With no matching rule the built-in verdict stands.
 *
 * Like the built-in rules it changes a lens, never a verdict: an overridden
 * component's findings are still counted, scored and listed under All, and
 * still shown anywhere when exploited.
 */
export function applyTierRules(
    builtin: Tier,
    component: { name: string; purl?: string | null; path?: string | null },
    rules: readonly TierRule[]
): Tier {
    let best: TierRule | null = null;
    let bestRank = -1;
    for (const rule of rules) {
        if (!ruleMatches(rule, component)) continue;
        const rank = (rule.matchKind === "name" ? 1_000_000 : 0) + rule.pattern.length;
        if (rank > bestRank) {
            best = rule;
            bestRank = rank;
        }
    }
    return best ? best.tier : builtin;
}

/** The property names the classifier reads; the backfill selects exactly these. */
export const TIER_PROPERTY_NAMES = [
    "syft:package:type",
    "syft:location:0:path",
    "syft:metadata:mainModule",
] as const;

/** Classify from a component's raw CycloneDX property list. */
export function classifyFromProperties(
    component: { name: string },
    properties: Iterable<{ name: string; value: string }>
): Tier {
    let packageType: string | null = null;
    let path: string | null = null;
    let mainModule: string | null = null;
    for (const p of properties) {
        if (p.name === "syft:package:type") packageType = p.value;
        else if (p.name === "syft:location:0:path") path = p.value;
        else if (p.name === "syft:metadata:mainModule") mainModule = p.value;
    }
    return classifyComponent({
        packageType,
        name: component.name,
        path,
        mainModule,
    });
}

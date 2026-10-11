/**
 * Orchestration — turning a component into a list of vulnerabilities.
 *
 * Everything else in this module answers one narrow question. This file decides
 * *which* questions to ask and what to do with the answers:
 *
 *   1. Parse the component's PURL into an identity, and derive its canonical
 *      key. No PURL, no match — there is nothing else to look up by.
 *   2. If the component names an `upstream=`, derive a second identity and key
 *      from it. Distros publish advisories against the source package, so a
 *      binary package that skips this pass misses every advisory for it.
 *   3. Drop any pass whose version is a placeholder — `(devel)`, `"unknown"`,
 *      absent. There is no version question to ask, so there is no answer to
 *      report (`hasAnswerableVersion`).
 *   4. Fetch candidates for the surviving keys in one round-trip.
 *   5. Scope each candidate to the component's distro release. An Alpine
 *      package is a candidate for `Alpine:v3.23` advisories, not for the 22
 *      other branches that share its name.
 *   6. Ask `ranges.ts` whether the version is affected. Drop the candidates it
 *      confirms are *not*.
 *   7. Reduce to one row per vulnerability.
 *
 * Steps 5 and 6 are where false positives are killed, and step 5 is the one
 * that used to leak: a base PURL like `pkg:apk/alpine/curl` is identical across
 * every Alpine branch ever released, which is how a 2016 CVE fixed in Alpine
 * 3.4 ended up attached to a package from Alpine 3.23.
 */

import { ecosystemMatchesDistro, releaseScope, schemeForPurlType } from "./ecosystem.js";
import { canonicalKey, parsePurl, upstreamIdentity } from "./identity.js";
import type { PackageIdentity } from "./identity.js";
import { evaluateAffected, isUnknownVersion } from "./ranges.js";
import type { Candidate, CandidateKey, CandidateStore } from "./store.js";

// ===== Types =====

/** What the matcher needs to know about a component. */
export interface ComponentInput {
    purl?: string | null;
    name: string;
    version?: string | null;
}

/**
 * How much to trust a match.
 *
 * `exact`       — the version was compared under a real comparator for the
 *                 ecosystem and fell inside a stated range.
 * `fuzzy`       — it fell inside a range, but a comparison along the way had to
 *                 guess (`version/fuzzy.ts`, or a bound outside its scheme's
 *                 grammar).
 * `unconfirmed` — the *package* matched and the question was asked, but the
 *                 advisory's own bounds could not answer it: nothing could
 *                 order them. Reported rather than dropped, because the
 *                 identity match is real and a silent drop is a false negative
 *                 with no paper trail.
 *
 *                 Note what no longer reaches here: a component with no usable
 *                 version of its own. That pass is dropped before the lookup
 *                 (`hasAnswerableVersion`) — the question was never asked, so
 *                 there is no open answer to record.
 */
export type MatchConfidence = "exact" | "fuzzy" | "unconfirmed";

export interface VulnMatch {
    /** Internal UUID of the matched `vulnerabilities` row. */
    vulnerabilityId: string;
    /** `direct` — the component's own identity. `indirect` — via `upstream=`. */
    matchType: "direct" | "indirect";
    /** Reserved for future `"cpe" | "name"` lookups. */
    matchedBy: "purl";
    confidence: MatchConfidence;
    fixedVersion: string | null;
    /** Full OSV ecosystem string of the candidate that matched. */
    ecosystem: string | null;
    packageName: string;
    /** Present only on an indirect match: the source package that matched. */
    upstream?: { name: string; version: string | null };
}

export interface Matcher {
    /** Every vulnerability affecting one component. */
    findVulnerabilities(component: ComponentInput): Promise<VulnMatch[]>;

    /**
     * The same, for many components in one round-trip.
     *
     * Every input id appears in the result, mapped to `[]` when nothing
     * matched, so callers can iterate the map rather than the input.
     */
    findVulnerabilitiesBatch(
        components: readonly (ComponentInput & { id: string })[],
    ): Promise<Map<string, VulnMatch[]>>;
}

// ===== Passes =====

/**
 * One identity to look up, and how to label what it finds.
 *
 * A component produces one or two of these: its own identity, and — when it
 * names a source package — that package's. Both are looked up the same way;
 * only the label and the version differ.
 */
interface Pass {
    identity: PackageIdentity;
    key: string;
    /**
     * How far the store may narrow this key by distro release — step 5 of the
     * module header, pushed into the lookup (`releaseScope`). `collectPass`
     * applies the same rule again in memory.
     */
    releases: readonly string[] | null;
    matchType: "direct" | "indirect";
    /** The version to range-check under this pass. */
    version: string | null;
}

/**
 * The passes to run for a component, in precedence order.
 *
 * The version each pass checks is the subtle part. The direct pass prefers the
 * component's own `version` field over the one embedded in its PURL — the two
 * agree in practice, and the field is what the SBOM actually declared. The
 * indirect pass prefers the version the `upstream=` qualifier stated, because
 * an advisory written against the source package is written against *source*
 * versions: an Ubuntu binary `2.4.1-1ubuntu2` built from source `2.4.1-1` must
 * be checked as `2.4.1-1`, or the comparison is between two different things.
 * (`upstreamIdentity` has already resolved that preference.)
 */
function passesFor(component: ComponentInput): Pass[] {
    const identity = parsePurl(component.purl);
    if (identity === null) return [];

    const componentVersion = component.version ?? null;

    const passes: Pass[] = [
        {
            identity,
            key: canonicalKey(identity),
            releases: releaseScope(identity.distro?.version, identity.type),
            matchType: "direct",
            version: componentVersion ?? identity.version,
        },
    ];

    const upstream = upstreamIdentity(identity);
    if (upstream !== null) {
        passes.push({
            identity: upstream,
            key: canonicalKey(upstream),
            releases: releaseScope(upstream.distro?.version, upstream.type),
            matchType: "indirect",
            version: upstream.version ?? componentVersion,
        });
    }

    return passes.filter(hasAnswerableVersion);
}

/**
 * Does this pass carry a version the range check can actually be *asked* about?
 *
 * Everything in `ranges.ts` argues for reporting an open version question
 * rather than dropping it, and that argument holds — for a question that was
 * asked and could not be answered. A bound nobody can order is real evidence
 * that something is wrong with the advisory, and `unconfirmed` is where it
 * belongs.
 *
 * This is the other case: the *component* declared no version to ask with.
 * `"unknown"` is what a scanner writes when it cannot read one out of a binary,
 * `(devel)` is Go's own placeholder for a binary built outside a module, and an
 * absent version says the same thing in CycloneDX's spelling. There is no
 * question here to leave open — every candidate for the package would come back
 * `unconfirmed` regardless of what its bounds say, so the row records only that
 * the package name appeared in the mirror.
 *
 * That is not free. On the workload this rule came from, six Go advisories
 * fanned out across thirty-nine `(devel)` components into 3,216 rows, 31% of
 * the whole findings table — none of them ever shown to a user, because
 * `db/findings.ts` counts only what the matcher positively placed inside a
 * range. Dropping the pass keeps the table honest about what it holds.
 *
 * grype does the same, more narrowly: it skips a `(devel)` package only when it
 * is the binary's own main module (`grype/matcher/golang/matcher.go:59`). We
 * checked whether that distinction was worth copying — `syft:metadata:mainModule`
 * does survive into the CycloneDX we ingest, so it could have been — and on the
 * measured data every remaining `(devel)` component *was* its binary's main
 * module once the subpath fold landed. The narrow rule would cost a component
 * property threaded through the matcher to reach the same answer.
 *
 * Scoped to the pass rather than the component: a binary package with no
 * version of its own but an `upstream=openssl@3.5.5-r0` qualifier still has an
 * answerable indirect question, and still gets asked it.
 */
function hasAnswerableVersion(pass: Pass): boolean {
    return !isUnknownVersion(pass.version);
}

// ===== Precedence =====

const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
    exact: 0,
    fuzzy: 1,
    unconfirmed: 2,
};

/**
 * Should `next` replace `current` as the row for this vulnerability?
 *
 * `component_vulnerabilities` holds one row per (component, vulnerability), so
 * a vulnerability reachable both directly and through the source package has to
 * be reduced to one. Match type leads: a direct hit is a statement about *this*
 * package, while an indirect one is inherited from what it was built from, and
 * the direct statement is the more precise of the two even when the indirect
 * one carries a firmer version verdict. Within a type, better confidence wins.
 */
function supersedes(next: VulnMatch, current: VulnMatch): boolean {
    if (next.matchType !== current.matchType) return next.matchType === "direct";

    return CONFIDENCE_RANK[next.confidence] < CONFIDENCE_RANK[current.confidence];
}

// ===== Matching one component =====

/**
 * Evaluate one pass's candidates and fold them into `matches`.
 *
 * Release scoping runs before the version check rather than after, because it
 * is both cheaper and more decisive: a candidate from the wrong distro branch
 * is not a weak match, it is not a match at all, and its version bounds are
 * meaningless against this component.
 */
function collectPass(pass: Pass, candidates: readonly Candidate[], matches: Map<string, VulnMatch>): void {
    const distroVersion = pass.identity.distro?.version ?? null;
    const packageScheme = schemeForPurlType(pass.identity.type);

    for (const candidate of candidates) {
        // Belt and braces: the store already excludes these (see `store.ts`).
        if (candidate.withdrawn) continue;

        if (!ecosystemMatchesDistro(candidate.ecosystem, distroVersion, pass.identity.type)) continue;

        const verdict = evaluateAffected(pass.version, candidate, packageScheme);

        // A confirmed "not affected" is the one outcome that ends a candidate's
        // life. `null` does not: it means unanswered, not answered no.
        if (verdict?.affected === false) continue;

        const match: VulnMatch = {
            vulnerabilityId: candidate.vulnerabilityId,
            matchType: pass.matchType,
            matchedBy: "purl",
            confidence: verdict === null ? "unconfirmed" : verdict.confidence,
            fixedVersion: candidate.fixedVersion,
            ecosystem: candidate.ecosystem,
            packageName: candidate.packageName,
            ...(pass.matchType === "indirect" ? { upstream: { name: pass.identity.name, version: pass.version } } : {}),
        };

        const existing = matches.get(match.vulnerabilityId);
        if (existing === undefined || supersedes(match, existing)) {
            matches.set(match.vulnerabilityId, match);
        }
    }
}

function matchComponent(passes: readonly Pass[], candidatesByKey: ReadonlyMap<string, Candidate[]>): VulnMatch[] {
    const matches = new Map<string, VulnMatch>();

    for (const pass of passes) {
        collectPass(pass, candidatesByKey.get(pass.key) ?? [], matches);
    }

    return [...matches.values()];
}

// ===== Public API =====

/**
 * Build a matcher over a candidate store.
 *
 * Both methods share one implementation: the single-component path is the batch
 * path with one element. There is no fast path worth keeping separate — the
 * cost is dominated by the store round-trip either way, and two code paths for
 * the same rules is how they drift.
 */
export function createMatcher(store: CandidateStore): Matcher {
    async function run(entries: readonly { id: string; passes: Pass[] }[]): Promise<Map<string, VulnMatch[]>> {
        const results = new Map<string, VulnMatch[]>();

        const keys: CandidateKey[] = [];
        for (const entry of entries) {
            for (const pass of entry.passes) keys.push({ key: pass.key, releases: pass.releases });
        }

        // Components without a parseable PURL contribute no keys, so an SBOM of
        // nothing but those never touches the database. The store merges
        // repeated keys itself.
        const candidatesByKey = keys.length === 0 ? new Map<string, Candidate[]>() : await store.findByKeys(keys);

        for (const entry of entries) {
            results.set(entry.id, matchComponent(entry.passes, candidatesByKey));
        }

        return results;
    }

    return {
        async findVulnerabilities(component: ComponentInput): Promise<VulnMatch[]> {
            const results = await run([{ id: "component", passes: passesFor(component) }]);
            return results.get("component") ?? [];
        },

        async findVulnerabilitiesBatch(
            components: readonly (ComponentInput & { id: string })[],
        ): Promise<Map<string, VulnMatch[]>> {
            return run(components.map((c) => ({ id: c.id, passes: passesFor(c) })));
        },
    };
}

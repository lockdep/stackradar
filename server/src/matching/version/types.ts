/**
 * Version comparison contract.
 *
 * Every comparator in this directory is a total function over two strings that
 * returns either an ordering with a confidence, or `null`.
 *
 * `null` means *genuinely indeterminate*: we could not order these two strings
 * under this scheme. It is never coerced to `0`, and never to "not affected" —
 * the caller must propagate the uncertainty. This is the single rule that keeps
 * an unparseable advisory bound from silently reading as a confirmed hit (or a
 * confirmed miss).
 */

/** How versions in an ecosystem are ordered. */
export type Scheme =
    "semver" | "golang" | "apk" | "dpkg" | "rpm" | "pep440" | "maven" | "gem" | "nuget" | "composer" | "fuzzy";

/**
 * How much to trust an ordering.
 *
 * `exact` — the scheme's own algorithm ordered these two strings.
 * `fuzzy` — the comparator had to guess: the input did not fit the scheme's
 *           grammar, or no scheme applied and the permissive fallback ran.
 */
export type Confidence = "exact" | "fuzzy";

/** The result of ordering two versions, or `null` when indeterminate. */
export type Comparison = { cmp: -1 | 0 | 1; confidence: Confidence } | null;

export interface CompareOptions {
    /**
     * The advisory's declared scheme. Tried when the primary scheme cannot
     * order the pair — grype's dual-format retry (`version/version.go:132`).
     * Cheap robustness against a single malformed record.
     */
    fallbackScheme?: Scheme | null;

    /**
     * Compare under the ecosystem's *native* semantics, switching off the
     * leniencies that only make sense when matching OSV advisories against
     * SBOM components (see `dpkg.ts` / `rpm.ts`).
     *
     * This exists so the vendored conformance corpora — which were generated
     * by the real package managers — can be asserted against unmodified. The
     * matcher never sets it.
     */
    strict?: boolean;
}

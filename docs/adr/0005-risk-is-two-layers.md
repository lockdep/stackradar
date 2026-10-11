# Risk is two layers, and the advisory layer is a generated column

**Status:** Accepted; amended by [ADR 0007](0007-aggregate-risk-is-an-unbounded-sum.md) (the aggregate fold is replaced, the two-layer split stands).
**Date:** 2026-08-16

> **Superseded in part by [ADR 0007](0007-aggregate-risk-is-an-unbounded-sum.md):**
> the aggregate layer described below (the bounded rank-decayed noisy-OR) has
> been replaced by an unbounded sum of finding risks. The two-layer split, the
> generated advisory column and the exclusion of exposure all still stand.

One number, 0–100, says which of forty workloads to fix first. It is computed in
two places rather than one:

```
vulnerabilities.risk_score            GENERATED ALWAYS AS (…) STORED
    = 100 × impact × exploitation
    impact        CVSS ÷ 10, or the severity band's midpoint when there is no vector
    exploitation  1.0 if on CISA KEV, else ∛(EPSS score), else 0.10

aggregate risk                        computed at read time, per group
    = 100 × (1 − Π (1 − rᵢ⁄100 · 0.8ⁱ))   rᵢ sorted descending, i from 0
```

The formula and every constant in it live in
[`server/src/db/risk-model.ts`](../../server/src/db/risk-model.ts); the fold over
images, workloads and releases lives in
[`server/src/db/risk.ts`](../../server/src/db/risk.ts).

Exposure — pod count, init-vs-serving, days unpatched — is in **neither**. It
renders in its own columns beside the score.

## Why two layers

The original risk-ranking proposal asked for one composite
score per finding, stored on `component_vulnerabilities`, with exploitation,
severity *and* exposure as inputs. The first two are properties of the advisory.
The third is not, and under [ADR 0004](0004-image-as-the-unit-of-identity.md) it
cannot be.

A finding keys on an image digest. One image running in five workloads is **one**
finding with five different pod counts, five namespaces and five ages. There is
no row to write that number on. The proposal was written against the `projects`
tree, where a finding did belong to one place it ran; the cutover removed the row
its exposure term needed.

So: the advisory layer is a pure function of one row of `vulnerabilities`, and
the aggregate layer is where a *group* of findings becomes a number for the thing
that carries them.

## Why the advisory layer is generated, not stored

Every input — `cvss_score`, `severity_level`, `epss_score`, `kev_listed_at` — is
a column of the same row, and the expression over them is immutable. That makes
`GENERATED ALWAYS AS (…) STORED` available, and it is strictly better than a
written column:

- **The daily EPSS refresh is the recomputation.** Postgres re-evaluates on any
  `UPDATE` to the row, so ~200k advisory updates re-score every finding that
  hangs off them. The alternative in the proposal — a nightly sweep over
  `component_vulnerabilities` — recomputes millions of rows to restate a function
  of two hundred thousand.
- **Drift is unrepresentable.** A score that outlives the data it was computed
  from is not a failure mode that exists. No caller can write the column;
  `tests/integration/findings/risk-model-parity.test.ts` asserts the error.
- **It is indexable.** `vulnerabilities_risk_score_idx` makes "the worst findings
  here" a top-N over an index. *(2026-09-12: the index was dropped — every
  ranking runs within a scope's findings and the planner never used it; see
  `docs/db-performance-plan-2026-09-12.md` item 6. The property still holds.)*

The cost is that changing the formula is a migration. That is the right price:
the formula is a product decision and should not be quietly deployable.

## Why exposure is not in the number

This was a decision, not an omission.

risk-ranking.md's own argument for the feature is that "the credibility of the
whole product rests on findings being traceable to a public advisory". Every
input above is a public fact with a URL: FIRST.org publishes the EPSS score, CISA
publishes the KEV listing, the advisory publishes the CVSS vector. A multiplier
of 1.15 for "twelve pods" is not, and it is the first thing a security engineer
would argue with — at which point the parts of the number that *are* defensible
are inside a number that is not.

The cost is real and worth stating: a workload scaled to zero scores the same as
one serving traffic. The mitigation is that pod count, age and the init flag are
columns on the same row, sortable, one glance away.

Revisit this by adding a **second** column, never by folding a guess into this
one.

## Why the aggregate is a rank-decayed noisy-OR

Four properties are required, and the two obvious functions each fail one:

| | monotone | bounded | worst-dominated | saturating |
|---|---|---|---|---|
| sum | ✓ | ✗ | ✗ | ✗ |
| mean | ✗ | ✓ | ✗ | ✓ |
| noisy-OR | ✓ | ✓ | ✓ | ✗ |
| **rank-decayed noisy-OR** | ✓ | ✓ | ✓ | ✓ |

A **sum** lets five hundred findings at 0.2 outscore a KEV critical at 98 — the
exact prioritisation failure the feature exists to remove. A **mean** means
discovering an extra low-severity package *improves* a workload's standing.
Plain **noisy-OR** has the first three but saturates badly: five hundred findings
at 0.002 reach 63, because enough near-zero probabilities still union to a large
one.

The `0.8ⁱ` rank decay fixes the fourth. Measured, both in SQL and in TypeScript:

| group | plain noisy-OR | with decay |
|---|---|---|
| one KEV critical (98) | 98.0 | **98.0** |
| 500 trivial findings (0.2 each) | 63.2 | **1.0** |
| ten serious findings (50 each) | 99.9 | **93.3** |
| one KEV critical + 500 trivial | 98.7 | **98.0** |

Ten serious things are worse than one and nowhere near ten times worse, which is
what makes the number comparable between a 12-component image and a
4,000-component one.

**The fold does not compose.** Rank is per group, so a workload's score must be
folded from its raw findings and never from its images' scores — the second
image's worst finding would get an undecayed rank-1 slot. This is why
`risk.ts` has four functions that differ only in their joins.

## Why ∛(EPSS) and not EPSS

The EPSS distribution is extreme: median around 0.0005, with a long thin tail.
Used linearly, every finding outside the top thousandth is arithmetically
indistinguishable from zero and the aggregate collapses to "the one CVE with a
score". The cube root spreads it — 0.001 → 0.10, 0.1 → 0.46, 0.97 → 0.99 — and
being a monotone transform it changes how far apart two findings sit, never which
is in front.

Not `epss_percentile`: it is uniform by construction, so the median CVE would
arrive as 0.5, asserting half of all CVEs are moderately likely to be exploited.
FIRST.org's own finding is that under 5% are ever exploited. Percentile is worth
*showing* and worthless as a weight.

## Why a missing EPSS score is 0.10 and not 0

EPSS covers CVEs. `MAL-*` records and `GHSA-*`/`PYSEC-*` without a CVE alias have
no score and never will. Both obvious rules are wrong: zero buries a real
vulnerability because nobody modelled it, and one floods the top of the list with
the unmodellable.

0.10 is what the transform returns for an EPSS of 0.001, close to the corpus
median. The rule is "an unscored advisory is exploited about as often as a
typical one", so it ranks on CVSS alone. **The UI renders `EPSS —` for these** —
the stand-in is our assumption, not FIRST.org's finding, and printing it as a
score would attribute it to them.

## Consequences

- KEV stays a **badge as well as** a weight. A KEV listing on a CVSS 3.1 advisory
  scores 31 and sorts unremarkably; the badge is what says *someone is exploiting
  this right now*, which is a different kind of fact from a probability.
- The KEV sync is a **full replacement**, not an upsert. `kev_listed_at` pins
  exploitation at 1.0, so a listing that outlives CISA's withdrawal holds a
  finding at the top of every list forever. Both feeds refuse a short file for
  the same reason in mirror image — see `kev-sync/repository.ts`.
- Both proposals point EPSS at a table called `osv_vulns`. **There is no such
  table**; the OSV mirror writes into `vulnerabilities` directly. The
  propagation step those documents describe does not exist and is not needed.
- The score is not exposure-aware, so **the workloads list shows pods and age as
  their own columns**. Removing them would silently make the ranking worse.
- Anything that changes the formula changes 300,000 stored values and needs a
  migration and a re-deploy. Deliberate.

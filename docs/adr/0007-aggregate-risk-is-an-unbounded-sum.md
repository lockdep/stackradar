# Aggregate risk is an unbounded sum

**Status:** accepted, implemented.
**Supersedes:** the aggregate layer of
[ADR 0005](0005-risk-is-two-layers.md) (the bounded rank-decayed noisy-OR).
ADR 0005 is otherwise unchanged: risk is still two layers, the advisory layer
is still a generated column over CVSS × EPSS × KEV, and exposure is still in
neither. Only the fold is replaced.

```
aggregate risk        computed at read time, per group
    = Σ rᵢ            the plain sum of the group's finding risks, rounded
```

The formula lives in [`server/src/db/risk-model.ts`](../../server/src/db/risk-model.ts);
the folds over images, workloads, releases, clusters and the org live in
[`server/src/db/risk.ts`](../../server/src/db/risk.ts).

## What changed, and why

ADR 0005 built the aggregate as a **ranking**: bounded 0–100, dominated by the
worst finding, saturating on the tail, so that "which of these forty workloads
first" had a defensible answer. It did that job. What it could not do is what a
Dependency-Track user expects of a risk score, and what the Cluster Overview
and Dashboard need:

- **It saturated.** Any cluster with one serious finding sat in the 90s, and
  stayed there. Two clusters in very different shape were indistinguishable at
  the level where the comparison matters most.
- **It barely moved.** Fixing the tenth-worst finding changed the number by
  effectively nothing, so a week of real remediation work was invisible in the
  headline figure. A score that cannot show progress is a score nobody watches.
- **It did not compose.** A cluster's score could not be built from its
  images' scores, which forced every surface through one fold implementation
  and made an org-level number a fifth bespoke query.

Dependency-Track's Inherited Risk Score
(`critical×10 + high×5 + medium×3 + low×1 + unassigned×5`) has the opposite
trade: an unbounded **magnitude** that grows with the pile and shrinks as it is
fixed. That is the number this product's audience already reads daily. We adopt
its shape but not its weights: each finding contributes its `advisoryRisk`, so
EPSS and KEV still decide what a finding is worth — a KEV-listed critical adds
~98 where a never-exploited critical adds ~7. The exploitation-awareness that
is the product's differentiator survives inside every term of the sum.

## What the sum gives up, and where that job went

ADR 0005's table showed a sum failing "worst-dominated": five hundred trivial
findings (0.2 each) now outscore one KEV critical (98). That was the reason the
sum was rejected, and it is still true. The decision here is that the aggregate
was answering two questions with one number, and it now answers only one:

- **"How much vulnerability debt?"** — the score. Unbounded, monotone,
  composable, visibly responsive to fixes.
- **"How bad is the worst thing in here?"** — the rollup's **band** (colour),
  which is the band of the group's *worst finding*, never a threshold on the
  total. The `RISK_BANDS` boundaries are unchanged and are defined over a
  single finding's 0–100 score. KEV keeps its distinct badge as before.

Sorting a list by the score therefore ranks by magnitude, not urgency. The
worst-finding urgency is still on every row — the band, the KEV badge, the
`topFinding` in the tooltip — and every rollup carries `topFinding` precisely
so a row can say what is driving it.

## Consequences

- **The fold composes.** A workload's score is the sum of its distinct images'
  scores; the org total is the sum of the cluster totals. `risk.ts` still folds
  each group from raw findings (one query beats N, and the distinct step
  guarding double-mounted digests is still mandatory), but composition is now a
  property callers may rely on rather than the bug the old module header warned
  about.
- **Cluster and org rollups became cheap**, and are now served: `/api/clusters`
  carries a `risk` rollup per cluster and one for the org, rendered on the
  Clusters list, the cluster Overview and the Dashboard.
- **The advisory layer is untouched.** `vulnerabilities.risk_score` is the same
  generated column; no migration.
- **Bands never apply to aggregates.** Any UI or query that colours a rollup
  must use the worst-finding band the rollup carries, not `riskBand(total)` —
  a threshold on the total is a threshold on finding count.

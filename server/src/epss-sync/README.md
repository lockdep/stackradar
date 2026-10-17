# EPSS Score Sync

A daily mirror of [EPSS](https://www.first.org/epss/) exploitation probabilities
from FIRST.org, joined onto the advisory mirror.

> **Status: implemented.** `pnpm epss-sync --once`, verified against the live
> feed. Its sibling is [`kev-sync/`](../kev-sync/README.md); the model both feed
> is [ADR 0005](../../../docs/adr/0005-risk-is-two-layers.md).

## What is EPSS?

A machine-learning model, updated daily, predicting the probability that a CVE
will be exploited in the wild within the next 30 days.

| Field             | Range   | Meaning                                         |
| ----------------- | ------- | ----------------------------------------------- |
| `epss_score`      | 0.0–1.0 | Probability of exploitation in the next 30 days |
| `epss_percentile` | 0.0–1.0 | Relative rank among all scored CVEs             |

CVSS measures _severity_ — what happens if it is exploited. EPSS measures
_likelihood_. Fewer than 5% of published CVEs are ever exploited, and EPSS is how
we find which 5%.

```
High CVSS + High EPSS  → fix now
High CVSS + Low EPSS   → monitor
Low  CVSS + High EPSS  → investigate
Low  CVSS + Low EPSS   → deprioritise
```

**We use the score and not the percentile as a weight.** Percentile is uniform by
construction, so the median CVE arrives as 0.5 — asserting half of all CVEs are
moderately likely to be exploited, which contradicts FIRST.org's own finding.
Percentile is shown in the UI (`0.87, 99th pct` is how a human reads a
probability) and does not enter the model. See ADR 0005.

## Data source

```
https://epss.empiricalsecurity.com/epss_scores-current.csv.gz
```

Gzipped CSV, a comment header, a column header, then one row per scored CVE:

```
#model_version:v2026.06.15,score_date:2026-08-15T00:00:00+0000
cve,epss,percentile
CVE-2021-44228,0.99999,1.00000
```

~360,000 rows as of August 2026, ~3 MB compressed. Refreshed daily around
00:00 UTC.

## Where the scores go

> **Correction to the original design.** The design this sync was built
> from specified a table called `osv_vulns`.
> **There is no such table.** `db/schema/osv-mirror.ts` holds only the OSV sync's
> own bookkeeping — `osv_sync_state`, `osv_sync_runs`, `osv_sync_failures` — and
> the mirror writes advisories straight into `vulnerabilities`, their ranges into
> `vulnerability_affected_packages`.
>
> The correction makes the design _simpler_. EPSS lands on `vulnerabilities`
> directly, and the "propagate to the `vulnerabilities` table" step the original
> described does not exist, because there is nowhere to propagate from.

### Columns on `vulnerabilities`

```typescript
epssScore:      real("epss_score"),        // 0.0–1.0
epssPercentile: real("epss_percentile"),   // 0.0–1.0
epssUpdatedAt:  timestamp("epss_updated_at", { withTimezone: true }),
```

Nullable, and null is the _correct_ value for an advisory EPSS does not cover.
Never default it to zero — `risk-model.ts` has a documented rule for the null
(`UNSCORED_EXPLOITABILITY`), and a zero would assert FIRST.org has scored the
advisory as never exploited.

These columns are deliberately absent from every column list in
`vulnerability.repository.ts`: an OSV refresh restates the advisory and must not
blank the threat intelligence hanging off it.

### The recomputation that does not exist

`vulnerabilities.risk_score` is `GENERATED ALWAYS AS (…) STORED` over
`cvss_score`, `severity_level`, `epss_score` and `kev_listed_at`. Postgres
re-evaluates it on any `UPDATE` to the row, so **this sync is the
recomputation**. There is no second pass, no nightly sweep over
`component_vulnerabilities`, and no way for a stored score to disagree with its
inputs.

### `epss_sync_state`

One row, constant PK, same shape as `osv_sync_state`. Lives in
`db/schema/threat-intel.ts` next to `kev_sync_state`.

| Column            | Meaning                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `last_synced_at`  | Completion of the last **successful** run — what the freshness guard reads                                             |
| `last_score_date` | The feed's own `score_date`                                                                                            |
| `rows_in_file`    | Rows parsed                                                                                                            |
| `rows_matched`    | CVEs that reached an advisory, directly or via alias                                                                   |
| `rows_unmatched`  | CVEs with no advisory in the mirror — expected to be large                                                             |
| `last_error`      | Null when the last run succeeded                                                                                       |
| `run_started_at`  | Set when a run passes the freshness guard, cleared when it records; what the app shell's banner reads as "scoring now" |

`last_score_date` is the one that earns its place: it is what the _data_ says
about its own age, as opposed to when we fetched it. A sync that succeeds every
night against a feed frozen a fortnight ago is a healthy-looking pipeline serving
stale predictions, and this column is the only place that shows up.

A failed run records `last_error` and deliberately **does not** touch
`last_synced_at`, so the freshness the API reports keeps ageing and the retry is
not blocked by the guard.

## How it applies

```
FIRST.org (.csv.gz)
   │ stream, gunzip, parse line by line
   ▼
┌─ one transaction ──────────────────────────────────┐
│  epss_staging   temp table, whole file, batched    │
│  ↓  floor check: refuse a short file, roll back    │
│  epss_hits      both join paths, unioned           │
│  ↓                                                 │
│  UPDATE vulnerabilities … WHERE score moved        │
│  ↓  risk_score regenerates itself                  │
└────────────────────────────────────────────────────┘
   ▼
epss_sync_state
```

### Why whole-file staging, not per-batch `VALUES`

The original design specified ~440 `UPDATE … FROM (VALUES …)` statements, each
matching `vuln_id = cve OR aliases @> cve`. It was not built, for two reasons:

1. The `OR` denies the planner both indexes, so each statement degrades toward a
   sequential scan of a 300k-row table — 440 times over.
2. A run that dies half-way leaves some advisories on today's scores and some on
   yesterday's, with nothing recording which.

Staging the whole file inside one transaction makes every join a hash join over a
materialised set, makes the run atomic, and stops the alias path being the
expensive one.

```sql
CREATE TEMP TABLE epss_staging (cve text PRIMARY KEY, score real, percentile real)
  ON COMMIT DROP;

CREATE TEMP TABLE epss_hits ON COMMIT DROP AS
    SELECT v.id AS vuln_pk, e.cve, e.score, e.percentile
    FROM vulnerabilities v JOIN epss_staging e ON e.cve = upper(v.vuln_id)
  UNION ALL
    SELECT v.id, e.cve, e.score, e.percentile
    FROM vulnerabilities v
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(v.aliases,'[]'::jsonb)) a(alias)
    JOIN epss_staging e ON e.cve = upper(a.alias);

UPDATE vulnerabilities v
SET epss_score = r.score, epss_percentile = r.percentile, epss_updated_at = now()
FROM (SELECT vuln_pk, max(score) AS score, max(percentile) AS percentile
      FROM epss_hits GROUP BY vuln_pk) r
WHERE v.id = r.vuln_pk
  AND (v.epss_score IS DISTINCT FROM r.score
    OR v.epss_percentile IS DISTINCT FROM r.percentile);
```

### Why the alias path is not optional

EPSS is keyed by CVE. Much of what the matcher finds is not: `GHSA-*` for npm and
Go, `PYSEC-*`, `RUSTSEC-*`, and distro advisories. Most declare a CVE in
`aliases`. Skipping the alias join would leave whole ecosystems unscored — which
under `UNSCORED_EXPLOITABILITY` means every npm finding ranks on CVSS alone while
every Debian finding ranks on measured exploitation. That is not a coverage gap,
it is a systematic bias between ecosystems.

`max` for an advisory aliasing several CVEs: there is no basis for picking one, so
it takes the most exploited — the conservative direction. This is _not_ the
question `normalizedCveIdentity` refuses to answer in
`lib/vulnerability-aliases.ts`. That one decides whether two advisories are one
_finding_, where a wrong answer hides a vulnerability. This one decides how urgent
one advisory is, where the higher number is the safe answer.

Taking `max` of score and of percentile independently is safe because percentile
is monotone non-decreasing in score, so both maxima come from the same CVE.

### The short-file floor

`EPSS_MIN_ROWS_TO_APPLY` (default 150,000) is checked after staging and **inside
the transaction**, so a truncated download rolls back rather than landing.

A gzip stream cut mid-file decompresses cleanly up to the cut, so the row count
after parsing is the only reliable signal that the download was complete. And
every CVE missing from a short file would have its score _blanked_, which is not
a neutral state: it drops those findings to `UNSCORED_EXPLOITABILITY` and
reorders the product's entire priority list.

### Only rows that moved

The `IS DISTINCT FROM` guard skips advisories whose score has not changed, which
on a normal day is the large majority. Every skipped row is a dead tuple not
created and a generated column not recomputed.

## Performance

Measured against the live feed when the mirror held ~300k advisories:
**360,142 rows in 5.5 seconds**, download, gunzip, parse, stage, join and
update included. By September 2026 the mirror held ~1.9M advisories and the
same cycle took 2–5 minutes: the three-way join reads the whole mirror three
times, and the UPDATE rewrites ~560k rows most days, because FIRST.org nudges
nearly every score daily, so the "only rows that moved" guard skips little.

`apply` therefore runs `SET LOCAL statement_timeout = 0` at the top of its
transaction. The shared pool sets a 120 s `statement_timeout` per session
(`db/index.ts`), which killed every run from 2026-09-07 to 2026-09-13 after
an OSV ingest doubled the mirror overnight. The CronJob's
`activeDeadlineSeconds` is the ceiling on a run instead.

The transaction also takes `pg_try_advisory_xact_lock(EPSS_APPLY_LOCK_KEY)`
(`config.ts`) right after lifting the timeout. Two monolith replicas
(`src/topology.ts`) fire the daily cron in the same minute; the one that finds
the lock held raises `SyncLockHeldError`, which the worker reports as
`{ skipped: true, reason: "locked" }` — not a failure, and not written to the
state row. Transaction-scoped, so it can never be leaked.

## CLI

```
pnpm epss-sync --once      Run one cycle; skips if scores are already fresh
pnpm epss-sync --force     Run regardless of freshness
pnpm epss-sync --metrics   Show the last run's state without touching the feed
```

## Configuration

| Variable                       | Default                  | Description                     |
| ------------------------------ | ------------------------ | ------------------------------- |
| `DATABASE_URL`                 | (required)               | PostgreSQL connection string    |
| `EPSS_FEED_URL`                | FIRST.org current scores | Feed location                   |
| `EPSS_STAGING_BATCH_SIZE`      | `5000`                   | Rows per staging `INSERT`       |
| `EPSS_MIN_SYNC_INTERVAL_HOURS` | `23`                     | Freshness guard; 0 disables     |
| `EPSS_MIN_ROWS_TO_APPLY`       | `150000`                 | Refuse a file shorter than this |
| `EPSS_REQUEST_TIMEOUT_MS`      | `60000`                  | Download timeout                |
| `EPSS_MAX_RETRIES`             | `3`                      | Download retries                |
| `LOG_LEVEL`                    | `info`                   | Log level                       |

## Scheduling

Daily, any time. The 23-hour guard makes a manual re-trigger a no-op, so the
CronJob is safe to run more often than the feed changes.

A community install needs no manifest: the monolith's in-process scheduler
(`src/sync-scheduler.ts`) runs the same command. A hosted deployment on the
split topology keeps a CronJob of this shape with its other manifests:

```yaml
schedule: "15 6 * * *" # after FIRST.org's ~00:00 UTC publish; off :00 (hourly osv-sync)
concurrencyPolicy: Forbid
command: ["node", "dist/src/epss-sync/cli.js", "--once"]
backoffLimit: 1
activeDeadlineSeconds: 1800
```

## Coverage

Scored: advisories with a CVE id, and advisories with a CVE alias
(`GHSA-…`/`PYSEC-…`/`RUSTSEC-…` that cross-reference one).

Not scored, correctly: `MAL-*`, and any `GHSA-*`/`PYSEC-*` with no CVE alias.
`rows_unmatched` is expected to be in the hundreds of thousands — EPSS scores
every CVE in the NVD, while the mirror holds only those with an ecosystem or
distro advisory. It is the **matched** count collapsing that means the join
broke.

## Tests

`tests/integration/threat-intel/epss-sync.test.ts` — real database, stubbed feed.
The download is a `fetch` and a gunzip; what is worth testing is the two join
paths, the freshness guard, the short-file rollback, the no-op re-run, and that
the temp tables do not survive the transaction.

# CISA KEV Sync

A daily mirror of CISA's [Known Exploited Vulnerabilities
catalogue](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) onto the
advisory mirror.

> Sibling of [`epss-sync/`](../epss-sync/README.md). The model both feed is
> [ADR 0005](../../../docs/adr/0005-risk-is-two-layers.md).

## What KEV is, and why it is worth its own sync

EPSS predicts exploitation. KEV _records_ it: CISA lists a CVE there because it
has been observed exploited in the wild. That is not a probability to be blended
with a prediction of one, and it is the highest signal-to-effort data source
available — a boolean per CVE, plus a remediation deadline, in a single
unauthenticated JSON file of about 1,600 entries.

In the risk model, a KEV listing sets exploitation to 1.0. It is also **a badge,
not only a weight**: on a CVSS 3.1 advisory it scores 31 and sorts unremarkably,
and what the number cannot say is _someone is exploiting this right now_.

## Data source

```
https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
```

```json
{
  "catalogVersion": "2026.08.14",
  "dateReleased": "2026-08-14T14:00:00.0000Z",
  "count": 1665,
  "vulnerabilities": [
    {
      "cveID": "CVE-2021-44228",
      "vendorProject": "Apache",
      "product": "Log4j2",
      "dateAdded": "2021-12-10",
      "dueDate": "2021-12-24",
      "knownRansomwareCampaignUse": "Known"
    }
  ]
}
```

## What we keep, and what we do not

Four fields. Vendor, product, the prose description and the required action are
all restatements of what the advisory already says, and storing a second copy
invites the two to disagree.

| Column on `vulnerabilities` | Source                       | Why                                                      |
| --------------------------- | ---------------------------- | -------------------------------------------------------- |
| `kev_listed_at`             | `dateAdded`                  | When exploitation was confirmed — _not_ when we synced   |
| `kev_due_date`              | `dueDate`                    | CISA's federal deadline. Not our SLA; label it as CISA's |
| `kev_ransomware`            | `knownRansomwareCampaignUse` | `"Known"` / `"Unknown"`, verbatim                        |

`kev_listed_at` is a timestamp rather than a boolean because "is this exploited"
and "how long have we known" have the same answer here, and a boolean throws the
second away.

An entry with no `dateAdded` is **dropped**, not defaulted to today. A fabricated
date would say CISA confirmed exploitation on the day we happened to sync.

## Full replacement, not upsert — the whole design

Every other sync in this codebase adds and updates. This one also **clears**.

CISA removes entries. It is rare — a handful a year, when a CVE was listed in
error or is superseded — but `kev_listed_at` is the single most influential input
in the risk model. It pins exploitation at 1.0, which is roughly a 10× multiplier
over a typical advisory and puts the finding at the top of every list in the
product. An entry that is never cleared holds that position **forever, on
evidence its own source has withdrawn**.

So a run computes the set CISA currently publishes and makes the mirror match it,
in both directions, in one transaction. A delisting is logged at `warn`: it is
rare, it silently demotes findings that were at the top of every list yesterday,
and if the number is ever large the join broke rather than CISA having second
thoughts.

That asymmetry is also why the entry floor exists.

### The short-catalogue floor

`KEV_MIN_ENTRIES_TO_APPLY` (default 500). For a replacement sync, a truncated
download is not a partial update — **it is a mass deletion**, clearing KEV from
every CVE it omits. The catalogue passed 1,000 entries in 2023 and only grows.

Note this is the mirror image of the EPSS floor and for the same reason: there,
a short file blanks scores; here, a short file blanks listings. Both refuse.

## Alias resolution

Same two paths as EPSS — `vuln_id` and the `aliases` array — and for the same
reason: KEV is keyed by CVE, much of what the matcher finds is not, and skipping
the alias join would bias whole ecosystems.

Where an advisory aliases several listed CVEs it takes the **earliest**
`dateAdded` and the **earliest** `dueDate`. "Known exploited since" is a claim
about the first time any of them was confirmed, and the earliest deadline is the
binding one. Note this is the opposite reduction from EPSS's `max`, and the same
principle: both pick the more urgent answer.

`bool_or(ransomware = 'Known')` rather than an arbitrary pick — if any CVE the
advisory covers is used in ransomware campaigns, the advisory is.

## `kev_sync_state`

One row, constant PK, in `db/schema/threat-intel.ts`.

| Column               | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `last_synced_at`     | Completion of the last successful run                |
| `catalog_version`    | CISA's `catalogVersion` — the data's own age         |
| `released_at`        | CISA's `dateReleased`                                |
| `entries_in_catalog` | Entries parsed                                       |
| `entries_matched`    | Advisories the catalogue reached                     |
| `entries_cleared`    | Advisories delisted on the last run — watch this one |
| `last_error`         | Null when the last run succeeded                     |
| `run_started_at`     | Set while a run is in progress, as for EPSS          |

As with EPSS, a failed run records the error and leaves `last_synced_at` alone.

## CLI

```
pnpm kev-sync --once      Run one cycle; skips if the catalogue is fresh
pnpm kev-sync --force     Run regardless of freshness
pnpm kev-sync --metrics   Show the last run's state
```

## Configuration

| Variable                      | Default            |
| ----------------------------- | ------------------ |
| `DATABASE_URL`                | (required)         |
| `KEV_FEED_URL`                | cisa.gov catalogue |
| `KEV_MIN_SYNC_INTERVAL_HOURS` | `23`               |
| `KEV_MIN_ENTRIES_TO_APPLY`    | `500`              |
| `KEV_REQUEST_TIMEOUT_MS`      | `30000`            |
| `KEV_MAX_RETRIES`             | `3`                |

## Scheduling

Daily. CISA refreshes on weekdays. A community install needs no manifest: the
monolith's in-process scheduler (`src/sync-scheduler.ts`) runs the same
command. A hosted deployment on the split topology keeps a CronJob of this
shape with its other manifests:

```yaml
schedule: "15 7 * * *" # an hour after the EPSS sync; both UPDATE vulnerabilities
concurrencyPolicy: Forbid
command: ["node", "dist/src/kev-sync/cli.js", "--once"]
activeDeadlineSeconds: 1800 # the resolve step scans the whole mirror; see epss-sync/README.md
```

`apply` runs `SET LOCAL statement_timeout = 0` inside its transaction for the
same reason `epss-sync` does: the pool's 120 s session limit is sized for API
requests, and the three-way resolve join took 68–110 s against a ~1.9M-row
mirror in September 2026.

The transaction also takes `pg_try_advisory_xact_lock(KEV_APPLY_LOCK_KEY)`
(`config.ts`) right after lifting the timeout. Two monolith replicas
(`src/topology.ts`) fire the daily cron in the same minute; the one that finds
the lock held raises `SyncLockHeldError`, which the worker reports as
`{ skipped: true, reason: "locked" }` — not a failure, and not written to the
state row. Transaction-scoped, so it can never be leaked.

```yaml

```

There is no separate downloader module. The catalogue is under a megabyte of JSON
that has to be parsed whole before any of it is usable, so the streaming
machinery `epss-sync` needs for a 15 MB CSV would be ceremony here.

## Tests

`tests/integration/threat-intel/kev-sync.test.ts`. Most of it is about
_removal_ — that a delisting propagates through the alias path, that every KEV
column is cleared and not just the timestamp, that the risk score returns to its
unlisted value, and that a short catalogue is refused rather than clearing
everything.

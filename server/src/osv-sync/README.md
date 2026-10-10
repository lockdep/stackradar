# OSV Vulnerability Mirror Sync

A PostgreSQL-backed mirror of the [OSV.dev](https://osv.dev/) vulnerability dataset with one-time initialization and continuous incremental sync.

## Overview

This module maintains a local mirror of OSV vulnerability records in PostgreSQL. It supports:

- **Full Bootstrap**: Imports the complete dataset from `all.zip`. Never
  triggered by the *hourly* schedule; reached by a twice-daily
  no-op-unless-empty check (`--bootstrap-if-needed`) or by hand
  (`--full-refresh`)
- **Incremental Sync**: Polls `modified_id.csv` and applies only changed records
- **Generation Swap**: A rebuild is published atomically or not at all; the
  previous mirror serves matching throughout
- **Idempotent Operations**: Safe to rerun without creating duplicates or unnecessary updates
- **Singleton Enforcement**: Uses PostgreSQL advisory locks to ensure only one instance runs
- **Failure Resilience**: Per-request retry with exponential backoff, and a
  watermark that catches up after downtime rather than skipping past it
- **Fleet Rescans**: Every cycle that changes the mirror queues a
  `scheduled_scan` job for each image with an SBOM (`rescan.ts`), so existing
  findings track the mirror instead of freezing at upload time

## Quick Start

### 1. Apply Migrations

Migrations are applied by ArgoCD as a pre-sync job — see the repository
`CLAUDE.md`. Do not run them by hand.

### 2. Bootstrap the Mirror

A fresh database needs one full import. In a deployed cluster this happens on
its own: the `osv-bootstrap` CronJob runs `--bootstrap-if-needed` twice a day,
which exits immediately unless the mirror has never completed a generation. A
fresh install or a restored database recovers unattended within 12 hours. The
monolith topology (`src/topology.ts`, the community edition's default) runs
the same check in-process the moment the server listens, and then twice a
day — a self-hosted install bootstraps itself without anyone running a
command.

To do it now rather than wait — locally, or when a cluster is down and the next
check is hours away:

```bash
pnpm osv-sync --full-refresh
```

Either route will:
1. Download `all.zip` (~2.5 GB compressed) — or, with `OSV_ECOSYSTEMS` set,
   one `<Ecosystem>/all.zip` per ecosystem (see *Scoping the mirror*)
2. Parse and import ~900,000 vulnerability records (fewer when scoped)
3. Build a new *generation* of `vulnerability_affected_packages` alongside
   whatever is already being served, and swap it in atomically at the end
4. Set the `initialized` flag in the sync state table

`pnpm osv-sync --once` deliberately **refuses** to bootstrap: it exits non-zero
with "mirror is not initialized" rather than starting a multi-hour, unresumable
rebuild off an hourly trigger. The hourly job's deadline is sized for an
incremental run, so a rebuild started there would be killed and restarted from
zero on every tick, forever. That is why the two paths have separate CronJobs.

### 3. Keep It Up To Date

Run `pnpm osv-sync --once` on a schedule (see the CronJob below). Each run polls
`modified_id.csv` and applies only what changed.

A run that applied changes (or a completed bootstrap) also queues a
`scheduled_scan` job for every image that has an SBOM (`rescan.ts`), skipping
images with a scan already pending or running. The job worker drains the queue
at its own pace; this is what keeps existing findings current with the mirror
rather than frozen at the image's first scan. A run that applied nothing
queues nothing — re-matching against an identical mirror is pure load.

### Future work: diff-driven rescan targeting

The rescan pass is deliberately blunt: *every* image with an SBOM re-matches
after *any* mirror change. Matching is local DB work, so this is fine at the
current fleet size, but it re-does work for images whose packages the sync
never touched. The incremental sync knows exactly which records it applied,
so the refinement is to collect the changed `(ecosystem, package)` set from
the applied records and enqueue only images whose SBOM contains a component
in that set (via `components` → `sboms` → `images`). The enqueue guard,
priority and job shape in `rescan.ts` all stay the same — only the SELECT's
image set narrows. Worth doing when the hourly sweep's scan volume starts to
crowd the job queue or matcher load shows up in Postgres.

### Scoping the mirror (`OSV_ECOSYSTEMS`)

The cloud mirrors everything OSV publishes. A community install is the
dashboard for one cluster, and most of that corpus can never match anything
it runs, so `OSV_ECOSYSTEMS` scopes the mirror to a comma-separated
allow-list of OSV **directory** names — the names in
<https://storage.googleapis.com/osv-vulnerabilities/ecosystems.txt>, exactly
as spelled, spaces included (`Alpine,Debian,Red Hat,npm`). Unset, the
community edition uses `DEFAULT_COMMUNITY_ECOSYSTEMS` (`ecosystems.ts`: the
distros and package managers a Kubernetes cluster is made of) and the cloud
mirrors everything; `OSV_ECOSYSTEMS=*` asks for everything explicitly.

What changes when a scope is set:

- **Bootstrap** pulls `<dir>/all.zip` per ecosystem instead of the global
  archive. Names are checked against `ecosystems.txt` first and an unknown
  one fails the run — a bootstrap visits each record once and the
  incremental sync never revisits anything below the watermark, so a
  silently skipped ecosystem would be a permanent hole reported as a healthy
  mirror. Cross-listed advisories (a GHSA under both `npm/` and `Maven/`) are
  taken once, filtered by path before the entry is inflated.
- **Incremental sync** ignores `modified_id.csv` entries under other
  directories (before the cross-listing dedupe, so a record listed both in
  and out of scope is kept through its in-scope path). Skipped entries are
  not failures; the watermark moves past them.
- **`osv_sync_state.ecosystems`** records what the live generation was built
  from (`null` = everything). `--bootstrap-if-needed` compares it with the
  configured list and rebuilds when the list was **widened** — nothing else
  can add an ecosystem to a built mirror. `--once` warns every hour while
  the two disagree, and the admin OSV tab shows both.

The plan that introduced this (`docs/open-source-plan-2026-10-10.md`, step
06) records what the default list costs to bootstrap, per ecosystem. The
short version: `Ubuntu` and `npm` are most of the default list by bytes
(~1 GB of ~1.27 GB), and `Chainguard` and `Wolfi` are left out on purpose —
together they are another 1.36 GB and only matter to clusters running
`cgr.dev` images; add them to `OSV_ECOSYSTEMS` if yours does, and the next
bootstrap check rebuilds. Scoping buys a smaller *mirror* (no Android, Linux
kernel, GitHub Actions, OSS-Fuzz, …) more than a small download.

## CLI Commands

```bash
# Run a single sync cycle (initialization or incremental)
pnpm osv-sync --once

# Force re-initialization from all.zip (works even on an initialized mirror)
pnpm osv-sync --full-refresh

# Bootstrap only if the mirror is empty; exit 0 immediately otherwise
pnpm osv-sync --bootstrap-if-needed

# Show current sync metrics
pnpm osv-sync --metrics

# Show help
pnpm osv-sync --help

# Check the vendored OSV schema against upstream (see Vendored OSV Schema)
pnpm osv-schema:check
```

## Configuration

Configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5444/server` | PostgreSQL connection string |
| `OSV_ECOSYSTEMS` | community: the default list; cloud: everything | Comma-separated OSV directory names the mirror carries; `*` = everything. See *Scoping the mirror* |
| `OSV_OVERLAP_WINDOW_MINUTES` | `10` | Overlap window for incremental sync safety |
| `OSV_MAX_PARALLEL_DOWNLOADS` | `8` | Max concurrent HTTP downloads |
| `OSV_BATCH_SIZE` | `100` | Database batch commit size |
| `OSV_BULK_FALLBACK_THRESHOLD` | `5000` | Candidates above which a run pulls per-ecosystem archives instead of per-record GETs |
| `OSV_LAG_WARNING_THRESHOLD_HOURS` | `6` | Log warning if lag exceeds this |
| `OSV_FAILURE_RETENTION_DAYS` | `30` | Age at which a successful run sweeps `osv_sync_failures`; `0` disables |
| `OSV_USER_AGENT` | `sbom-tracker-osv-sync/1.0` | HTTP User-Agent string |
| `OSV_REQUEST_TIMEOUT_MS` | `30000` | HTTP request timeout, covering headers *and* body |
| `OSV_STREAM_STALL_TIMEOUT_MS` | `60000` | Abort a streamed body after this long with no bytes |
| `OSV_MAX_RETRIES` | `3` | Max HTTP retry attempts (4xx other than 429 are never retried) |
| `OSV_RETRY_BASE_DELAY_MS` | `1000` | Base delay for retry backoff |
| `OSV_ADVISORY_LOCK_ID` | `8675309` | PostgreSQL advisory lock ID |
| `OSV_BOOTSTRAP_MAX_FAILED_ENTRIES` | `1000` | Failed entries a rebuild may have and still publish |
| `OSV_BOOTSTRAP_MAX_FAILED_ENTRY_RATIO` | `0.005` | …and the proportion. Both must be exceeded to reject |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |

The three data-source URLs are overridable too — `OSV_ALL_ZIP_URL`,
`OSV_MODIFIED_CSV_URL` and `OSV_STORAGE_BASE_URL`, defaulting to the paths under
*Data Sources* below. They exist so a test or a staging run can be pointed at a
local fixture server instead of GCS.

## Database Schema

### `osv_sync_state`

Single-row table tracking sync state:

| Column | Type | Description |
|--------|------|-------------|
| `id` | `INTEGER` | Constant PK (always 1) |
| `initialized` | `BOOLEAN` | Whether full import completed |
| `init_completed_at` | `TIMESTAMPTZ` | When initialization finished |
| `last_successful_poll_at` | `TIMESTAMPTZ` | Last successful CSV poll |
| `last_modified_seen` | `TIMESTAMPTZ` | Max timestamp in CSV |
| `last_modified_applied` | `TIMESTAMPTZ` | Max timestamp applied to DB (watermark) |
| `last_full_refresh_at` | `TIMESTAMPTZ` | Last full refresh time |
| `sync_status` | `TEXT` | `idle` / `full_refresh` / `incremental` (observability only) |
| `affected_pkg_generation` | `INTEGER` | Which generation of `vulnerability_affected_packages` is live |
| `consecutive_failures` | `INTEGER` | Consecutive failed cycles; reported, not used to schedule anything (see *Failure Handling*) |
| `last_error` | `TEXT` | Last error message |
| `ecosystems` | `JSONB` | The OSV directories the live generation was built from; `null` = everything. Compared with `OSV_ECOSYSTEMS` by `--bootstrap-if-needed` |

### `vulnerabilities`

There is **no `osv_vuln` table.** Advisories land in `vulnerabilities`, the
shared table for every source (`source = 'osv'` here), and the `affected[]`
array is exploded into `vulnerability_affected_packages` rather than being left
inside the raw JSON. Only the columns this module writes or depends on are
listed; the definitions are in `src/db/schema/vulnerabilities.ts`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Surrogate PK — what `component_vulnerabilities` and the affected-package rows reference |
| `vuln_id` | `VARCHAR(100)` | OSV ID (`CVE-…`, `GHSA-…`, `PYSEC-…`), unique; the UPSERT conflict target |
| `source` | `VARCHAR(50)` | `'osv'` for everything this module writes |
| `summary` / `details` | `VARCHAR(512)` / `TEXT` | OSV `summary` and `details` |
| `severity` | `JSONB` | OSV `severity[]` — the CVSS vectors as published |
| `severity_level` / `cvss_score` | `VARCHAR(20)` / `REAL` | Derived at parse time by `cvss.ts` (`extractSeverity`), not carried by OSV. Reads, in order: record `severity[]` (CVSS v3 → v4 → v2 → `Ubuntu` label), `affected[].severity[]`, `database_specific.{severity,urgency,priority}`, `affected[].ecosystem_specific.{…}` (Debian `urgency`), then the `MAL-` heuristic — after dropping a publisher's placeholder vector (`PLACEHOLDER_SCORERS` in `cvss.ts`: Cleanstart's one-size 9.8), which is no score. `unknown` only when none of those is present — a v4-only or distro-labelled advisory is scored. Stamped at ingest, so a change here needs a full re-sync. A record left `unknown` then borrows both from a scored record of the same `finding_identity` (see `severity_source`) |
| `severity_source` | `VARCHAR(100)` | Null when the two columns above are the record's own; otherwise the `vuln_id` they were lent by — `GO-2026-4918` carrying `CVE-2026-33814`'s 7.5, since the Go vuln DB states no CVSS. Written by `severity-fill.ts` after every incremental batch (scoped to the identities the batch touched) and across the whole mirror after a bootstrap; nulled by every upsert. `pnpm osv-sync --fill-severity` runs the whole-mirror pass on its own |
| `aliases` / `related` / `references` / `credits` | `JSONB` | Copied through from the OSV record |
| `published_at` / `modified_at` / `withdrawn_at` | `TIMESTAMPTZ` | OSV `published` / `modified` / `withdrawn` |
| `raw_data` | `JSONB` | The full OSV record |
| `raw_hash` | `BYTEA` | SHA-256 of the downloaded bytes — the change detector the UPSERT filters on |

`modified_at` is the column the watermark is derived from: a bootstrap takes the
max over everything it imported, an incremental run the max it applied.

There is no ecosystem column here, and that is deliberate: one advisory can name
several ecosystems, so the ecosystem belongs to each `affected[]` entry rather
than to the record. The OSV *directory* an advisory was fetched from is not
stored at all beyond `osv_sync_failures.ecosystem_dir` — it is a property of the
download, not of the advisory, and cross-listed records are byte-identical
across directories.

### `vulnerability_affected_packages`

One row per `affected[]` entry, written by both sync paths. This is the table
the matcher reads, so its shape is driven by matching rather than by OSV.

| Column | Type | Description |
|--------|------|-------------|
| `vulnerability_id` | `UUID` | FK → `vulnerabilities.id`, `ON DELETE CASCADE` |
| `ecosystem` | `VARCHAR(100)` | Full OSV ecosystem string (`npm`, `Alpine:v3.23`, `Red Hat:enterprise_linux:8`) |
| `ecosystem_family` / `ecosystem_release` | `VARCHAR` | The same string split at its first colon, so release scoping is a SQL filter |
| `package_name` / `purl` | `VARCHAR` / `TEXT` | OSV `affected[].package.name` and `.purl` |
| `match_key` | `TEXT` | The canonical lookup key from `src/matching/identity.ts`, computed at ingest. Changing a key rule there means re-ingesting the mirror |
| `withdrawn` | `BOOLEAN` | Denormalized from `vulnerabilities.withdrawn_at` so the hot lookup needs no join |
| `ranges` / `versions` / `fixed_version` | `JSONB` / `VARCHAR` | OSV version ranges, explicit versions, and the fix derived from them |
| `generation` | `INTEGER` | Which rebuild this row belongs to (see below) |

**Every read must be scoped to the live generation** via `isCurrentGeneration()`
in `src/db/generation.ts`. A bootstrap writes generation `N+1` beside the live
`N`, so an unscoped read during a rebuild sees both and double-counts. The one
deliberate exception is the admin status query, whose job is to show what that
predicate hides.

### `osv_sync_runs`

One row per completed cycle — a queryable history that does not require keeping
logs. Carries `mode`, `success`, `records_processed`, `inserted` / `updated` /
`unchanged`, `affected_packages_extracted`, `schema_validation_warnings`,
`parse_failures`, `deduplicated_candidates`, `duration_ms`, `lag_seconds`, and
an `errors` JSONB array **capped at 100 entries** (it is a column, not a log,
and the bulk path makes five-figure failure counts possible).

### `osv_sync_failures`

Two different things share this table, and only one of them is bad news:

| `error_type` | Meaning | Counted in |
|---|---|---|
| `parse_error` | The record could not be read. **It is not in the mirror.** | `parse_failures` |
| `download_error` | The record could not be fetched. **It is not in the mirror.** | `parse_failures` |
| `validation_warning` | The record deviated from the OSV JSON schema and **was ingested anyway**. | `schema_validation_warnings` |

Keeping those counters apart matters more than it looks. When incremental sync
counted warnings as parse failures too, the admin dashboard reported ~25,000
"parse failures" against a mirror that had not lost a single advisory, and the
number stopped being watchable — which is exactly when a real one would have
been missed. Only `failCandidate()` in `incremental.ts` increments
`parse_failures`; it is the sole path an unusable record takes.

A steady non-zero warning count is normal and mostly not our problem: openSUSE
publishes `references` entries with no `url`, and OSV.dev's own CPE→OSV
converter emits ranges carrying both `last_affected` and `fixed`, which its own
schema forbids. **A jump in warnings usually means the vendored schema went
stale** — see *Vendored OSV Schema* below.

Keyed by `sync_run_id`, so `GET /api/admin/osv/parse-failures` can show
everything one run hit. Swept by `OSV_FAILURE_RETENTION_DAYS` — see *Failure
Retention* below.

## Vendored OSV Schema

`src/schemas/osv-specifications/osv.schema.json` is a copy of
`ossf/osv-schema@validation/schema.json`, pinned by
`osv.schema.lock.json` (upstream commit + sha256). It is vendored rather than
fetched because `osv.validator.ts` compiles it at process start — a sync worker
must not depend on GitHub being reachable, and a schema that changes under us
without a commit is a change nobody reviewed.

```bash
pnpm osv-schema:check    # drift against upstream main; exits 1 if behind
pnpm osv-schema:sync     # vendor upstream and update the lock
pnpm osv-schema:verify   # offline: vendored bytes still match the lock
```

`check` runs weekly in `.github/workflows/osv-schema-drift.yaml` and opens an
issue when it drifts. `verify` runs in the test suite
(`tests/unit/validators/osv-schema-lock.test.ts`), which is what catches the
file being hand-edited — upstream is the only source of truth here.

Drift is quiet, which is why it is automated: a stale schema does not fail, it
files conforming advisories as warnings. Upstream added the `CLSA` prefix,
our copy did not have it, and 8,104 CleanStart advisories were logged as
failures while being ingested perfectly.

Note that syncing can *raise* the warning count — upstream adds constraints as
well as relaxing them (it recently began requiring full-length GIT commit
hashes). That is expected: warnings do not block ingestion.

## Architecture

```
     pnpm osv-sync --once | --full-refresh | --bootstrap-if-needed | --metrics
                                    │              in-process crons (monolith)
┌───────────────────────────────────▼─────────────────────▼─────────────────┐
│                     cli.ts              ·        ../sync-scheduler.ts     │
│   both build the modules through runtime.ts; the CLI maps the result to   │
│   an exit code: skipped (lock held) ⇒ 0, noop (nothing to do) ⇒ 0,        │
│   failed ⇒ 1; the scheduler logs it and releases the lock between runs    │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────────┐
│                                worker.ts                                  │
│   advisory-lock singleton · stale sync_status reset · failure retention   │
│   sweep · --once refuses to bootstrap when initialized = false            │
│   --bootstrap-if-needed runs bootstrap only when initialized = false,     │
│   re-checking under the lock so it cannot duplicate a manual rebuild      │
└──────────────┬─────────────────────────────────────┬──────────────────────┘
 --full-refresh · --bootstrap-if-needed             --once
┌──────────────▼───────────────┐   ┌─────────────────▼──────────────────────┐
│         bootstrap.ts         │   │            incremental.ts              │
│  all.zip ⇒ generation N+1    │   │  modified_id.csv ⇒ the live generation │
│  while N keeps serving,      │   │  scanned newest-first and cut off at   │
│  then assess ⇒ promote or    │   │  the watermark; per-record GETs, or    │
│  discard the whole build     │   │  per-ecosystem archives on a burst day │
└──────────────┬───────────────┘   └─────────────────┬──────────────────────┘
               └──────────────────┬──────────────────┘
┌─────────────────────────────────▼─────────────────────────────────────────┐
│  downloader.ts     zip-processor.ts   parser.ts        state.ts           │
│  retries, body     yauzl streaming    OSV JSON ⇒ rows  osv_sync_state:    │
│  timeout, stall    to disk, path      + affected[],    watermark,         │
│  detector,         filter applied     CVSS (cvss.ts),  generation         │
│  streamLines()     before inflate     osv.validator    pointer, lock      │
└─────────────────────────────────┬─────────────────────────────────────────┘
┌─────────────────────────────────▼─────────────────────────────────────────┐
│  vulnerabilityRepository.bulkUpsertFromSync()  ⇒ vulnerabilities          │
│  affected-package-repository  ⇒ vulnerability_affected_packages (gen N)   │
│  run-repository ⇒ osv_sync_runs   failure-repository ⇒ osv_sync_failures  │
└─────────────────────────────────┬─────────────────────────────────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │         PostgreSQL         │
                    └─────────────┬──────────────┘
                                  │  reads scoped by isCurrentGeneration()
                    ┌─────────────▼──────────────┐
                    │  matcher · vulnerability   │
                    │  read paths · GET /metrics │
                    │  · admin OSV view          │
                    └────────────────────────────┘
```

Two things the boxes are hiding. `parser.ts` is not only a CSV parser — it is
also the OSV-record parser that both ingest paths run, and where the
`affected[]` explosion and the CVSS derivation happen. And the bottom row is not
part of this module at all: it is every reader of the mirror, drawn because the
generation pointer is a contract between the sync and all of them.

## How It Works

### Initialization Flow

Reached only through `--full-refresh` and `--bootstrap-if-needed`; `--once`
refuses to run it.

1. Read the live generation `N` from `osv_sync_state.affected_pkg_generation`
2. Download `all.zip` from OSV storage and stream its entries — or, scoped,
   each ecosystem's archive in turn (*Scoping the mirror*)
3. For each JSON file:
   - Parse the OSV record and compute its SHA256
   - UPSERT into `vulnerabilities`
   - Write its affected packages under generation `N+1`
4. Judge the finished import: too many failed entries, no records, or no
   watermark and it is **rejected** — generation `N+1` is dropped and `N` stays
   live. A failed rebuild is a no-op, not an outage.
5. Otherwise promote: move the pointer to `N+1` and delete every other
   generation, in one transaction
6. Set `initialized=true`, record the max modified timestamp and the
   ecosystem scope the generation was built with

Two rules make this safe to run unattended:

- **Nothing is truncated.** Readers serve generation `N` throughout the rebuild,
  and the swap is atomic, so matching never sees a partial mirror. All read
  paths scope themselves to the live generation via `src/db/generation.ts`.
- **A write failure is fatal.** A record that will not parse is skipped and
  counted; a failure in the database write aborts the run. A bootstrap visits
  each record once and incremental sync never revisits anything below the
  watermark, so a swallowed write error would be a permanent hole in the mirror
  reported as a healthy sync.

### Incremental Flow

1. Stream `modified_id.csv`, stopping at `last_modified_applied - overlap`
2. Deduplicate cross-listed advisories by vuln ID
3. Fetch the candidates — one GET each, or per-ecosystem archives on a burst day
4. UPSERT into `vulnerabilities` (only if the SHA differs)
5. Rebuild `vulnerability_affected_packages` rows for the advisories that changed
6. Update the `last_modified_applied` watermark

**The CSV is streamed, not parsed whole.** It is 45.8 MB / 896k lines going back
to 2002, sorted newest-first, and a typical hour touches ~220 of them. The scan
stops once it has seen a run of lines older than the cutoff, and abandons the
rest of the transfer. The sort order is OSV's implementation detail rather than a
documented guarantee, so it is checked while scanning: one out-of-order line and
the run degrades to reading the whole file, which is what it used to do anyway.

**Burst days fall back to archives.** ~220 entries change in a typical hour, but
a bulk republish or one missed window can mean tens of thousands. Above
`OSV_BULK_FALLBACK_THRESHOLD` candidates the run pulls each affected ecosystem's
`<Ecosystem>/all.zip` once instead of issuing per-record GETs at concurrency 8.
The archives are periodic snapshots, so a candidate that is missing from one, or
present but older than the CSV says, is recorded as a failure and caps the
watermark rather than being applied — nothing below the watermark is ever
revisited. This path does not checkpoint mid-run, because ZIP entry order has
nothing to do with `modified`.

Like `match_key` and `ecosystem_family`, the `vulnerabilities` row itself
carries one ingest-computed column: `finding_identity`, the cross-image
collapse key (`lib/vulnerability-aliases.ts#findingIdentityOf`, stamped in
`convertOsvRecordToVulnerability` from the record's id, `aliases` and
`upstream` — the last read off the raw record, since a distro tracker entry
names its CVE there and nowhere else). The sync is the only writer of advisory
rows, so rewriting a changed advisory is what keeps the stored identity
current.

### UPSERT Rule

The UPSERT is idempotent and avoids unnecessary writes:

```sql
INSERT INTO vulnerabilities (...)
ON CONFLICT (vuln_id) DO UPDATE SET ...
WHERE vulnerabilities.raw_hash IS DISTINCT FROM EXCLUDED.raw_hash
RETURNING id, vuln_id, (xmax = 0) AS inserted
```

This means:
- New records are inserted
- Existing records are only updated if content changed
- Repeated runs with the same data do not cause row updates
- The statement reports what it did: a filtered `ON CONFLICT` returns only the
  rows it wrote, and `xmax = 0` separates inserts from updates within those.
  `unchanged` is the remainder of the batch.

That last point is what lets an incremental run rebuild affected-package rows for
*changed* advisories only. Every overlap window re-downloads records the mirror
already has; rewriting their rows was churn and table bloat. A full rebuild asks
for the unchanged rows too (`includeUnchanged`) because it must write every
advisory into the new generation regardless.

### Singleton Enforcement

Uses PostgreSQL advisory locks to ensure only one instance runs:

```sql
SELECT pg_try_advisory_lock(8675309)
```

If the lock cannot be acquired the run is **skipped, not failed**: the result
carries `skipped: true` and the CLI exits 0. `concurrencyPolicy: Forbid` makes an
overlap rare, but a manual run alongside the CronJob is a normal thing to do and
must not spend the Job's `backoffLimit` or fire an alert.

### Failure Retention

Every run inserts a row into `osv_sync_failures` per schema-validation warning or
download/parse failure. A successful run sweeps rows older than
`OSV_FAILURE_RETENTION_DAYS` (default 30). The sweep is housekeeping — its own
failure is logged and swallowed rather than failing a sync that applied its
records correctly.

### Failure Handling

- A failed cycle increments `consecutive_failures` and records `last_error`; a
  successful one resets both.
- The watermark (`last_modified_applied`) is not advanced by a failed run, and a
  run with *partial* failures caps it below the oldest candidate it could not
  apply. Nothing below the watermark is ever revisited, so anything that did not
  land must stay in front of it.
- **There is no in-process backoff.** `consecutive_failures` is a signal, not a
  schedule: the process exits after one cycle and the CronJob decides when the
  next one starts. The counter is what `osv_mirror_consecutive_failures` and the
  admin view report, and what distinguishes one bad poll from a mirror that has
  been failing for a day.
- Retry backoff exists one level down, per HTTP request (`OSV_MAX_RETRIES`,
  `OSV_RETRY_BASE_DELAY_MS`), and 4xx other than 429 is never retried.

## Out of Sync Recovery

If the worker is stopped for a period of time:

1. On restart, it reads `last_modified_applied` from state
2. It processes all entries from CSV where `modified >= (watermark - overlap)`
3. The overlap window (default 10 minutes) handles clock skew and ensures no records are missed
4. Normal incremental sync resumes

## Monitoring

### Metrics Command

```bash
pnpm osv-sync --metrics
```

Output:
```
OSV Sync Metrics:
  Initialized: true
  Total vulnerability records: 903,412
  Total affected package rows: 4,118,776
  Lag: 0h 5m (300s)
  Consecutive failures: 0
```

`Last error` is printed only when one is recorded. The affected-package count is
scoped to the live generation, so a rebuild in progress does not roughly double
it; `vulnerabilities` has no generation column and is counted whole. There is no
per-ecosystem breakdown here — `GET /api/admin/osv` has it.

### Log Output

The worker logs one structured line per phase (fields shown flattened here):

```
INFO: Starting incremental sync syncRunId=…
INFO: Processing update candidates linesParsed=271 stoppedEarly=true
      orderingViolated=false candidateCount=218 deduplicatedCandidates=53
INFO: Incremental sync complete recordsProcessed=218 inserted=5 updated=201
      unchanged=12 affectedPackagesExtracted=1204 parseFailures=0 lagSeconds=42
```

`stoppedEarly=false` on a run that is not catching up means the CSV was read to
EOF — either the cutoff reached back past 2002, or `orderingViolated=true`
disabled the early stop.

### Lag Warning

If `lag_seconds > OSV_LAG_WARNING_THRESHOLD_HOURS * 3600`, a warning is logged:

```
WARN: Sync lag exceeds warning threshold lagSeconds=21600 lagHours=6 threshold=6
```

## Testing

```bash
# Run all tests
pnpm test

# Run OSV sync tests only
pnpm test tests/unit/osv-sync

# Run with coverage
pnpm test:coverage
```

## Deployment

### Where the manifests live

**Not in this repository.** They are in the `stackradar-gitops` repo, applied by
ArgoCD:

| File | What it is |
|---|---|
| `apps/stack-radar/base/server/osv-sync-cronjob.yaml` | The hourly incremental sync |
| `apps/stack-radar/base/server/osv-bootstrap-cronjob.yaml` | Twice-daily bootstrap-if-empty check |
| `apps/manual/osv-bootstrap-job.yaml` | Operator-triggered rebuild, for forcing one |
| `apps/stack-radar/base/server/servicemonitor.yaml` | Scrape config for the server's `/metrics` |
| `apps/stack-radar/base/server/prometheusrule.yaml` | Mirror staleness and failure alerts |

Earlier revisions of this file reproduced the CronJob inline; it drifted, and a
copy that disagrees with the real manifest is worse than no copy. Read the real
one.

### Kubernetes CronJob

Runs `pnpm osv-sync --once` hourly with `concurrencyPolicy: Forbid`.

**Incremental only.** If the mirror is not initialized the CronJob exits
non-zero with a message telling you to run the bootstrap instead — it will not
start a full rebuild. A 1.35 GB import that cannot resume has no business on an
hourly trigger, where a cleared `initialized` flag would restart it from zero
every hour forever.

The pod mounts an `emptyDir` at `TMPDIR=/tmp-osv`. The bulk-fallback path (see
*Burst days* above) downloads per-ecosystem archives to disk, and unaccounted
scratch space on the container's writable layer risks node-pressure eviction —
which takes neighbouring pods with it.

### Bootstrapping

Two routes, and the automatic one covers almost every case.

**`apps/stack-radar/base/server/osv-bootstrap-cronjob.yaml`** runs `--bootstrap-if-needed`
every 12 hours. It reads `initialized` and exits 0 in about a second when a
complete generation exists, so the steady-state cost is two trivial pods a day.
When the mirror is empty — fresh install, restored or nuked database — it runs
the full rebuild unattended with its own 8-hour deadline and `backoffLimit: 0`;
the next scheduled tick is the retry, which is the right cadence for a run that
re-downloads 1.35 GB.

It is a *CronJob*, which is what makes it safe under `selfHeal: true` where a
managed Job is not: ArgoCD reconciling a CronJob re-applies its spec, while
reconciling a Job would start one.

**`apps/manual/osv-bootstrap-job.yaml`** stays for the two cases the CronJob
will not handle: skipping the wait when the mirror is down and the next check is
hours away, and forcing a rebuild of a mirror that is already initialized, which
`--bootstrap-if-needed` refuses by design. It is deliberately outside every
kustomization and reads the image tag off the live server Deployment.

Matching stays up throughout — the rebuild writes a new generation beside the
live one and swaps the pointer in a single transaction at the end.

### Monitoring

The sync is a CronJob, which is the wrong shape to scrape: it lives for a few
minutes an hour, so Prometheus would miss most runs and see a new target for
each one. The mirror's health gauges are exposed by the **API server** instead,
read from `osv_sync_state` on each scrape at `GET /metrics` (cluster-only — the
`server-api` Ingress allow-lists four exact `/v1` paths and routes nothing else).

| Metric | Meaning |
|---|---|
| `osv_mirror_initialized` | 1 when a complete generation exists; while 0, matching 503s |
| `osv_mirror_last_successful_poll_age_seconds` | Seconds since the last successful poll |
| `osv_mirror_lag_seconds` | `last_modified_seen` − `last_modified_applied` |
| `osv_mirror_consecutive_failures` | Consecutive failed cycles |
| `osv_mirror_scrape_error` | 1 when the exporter itself cannot read the state table |

**Alert on poll age, not on lag.** `osv_mirror_lag_seconds` is computed from two
columns that only a *running* sync updates, so a sync that has stopped entirely
leaves it frozen at whatever it last was — usually 0, which reads as perfect
health. Poll age is the only one of these that keeps moving when nothing else
does. `prometheusrule.yaml` also carries a kube-state-metrics rule on the
CronJob's last successful completion, which does not depend on this application
being healthy at all.

Record counts are deliberately absent: a `count(*)` over ~900k vulnerabilities
on every 30s scrape is not a health check. `GET /api/admin/osv` has them.

**Adjusting schedule:**

```yaml
# Every 30 minutes
schedule: "*/30 * * * *"

# Every 6 hours
schedule: "0 */6 * * *"

# Daily at 3 AM
schedule: "0 3 * * *"
```

## Data Sources

- Full dump: `https://storage.googleapis.com/osv-vulnerabilities/all.zip`
- Incremental list: `https://storage.googleapis.com/osv-vulnerabilities/modified_id.csv`
- Individual records: `https://storage.googleapis.com/osv-vulnerabilities/<ECOSYSTEM>/<ID>.json`


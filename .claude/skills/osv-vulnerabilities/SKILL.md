---
name: osv-vulnerabilities
description: >-
  Domain knowledge for OSV vulnerability data, vulnerability matching, CVSS scoring,
  and the OSV sync pipeline. Use when working with vulnerabilities, OSV data,
  CVSS scores, severity levels, vulnerability scanning, or the osv-sync module.
---

# OSV & Vulnerability Domain Knowledge

## Key Concepts

| Term | Meaning |
|------|---------|
| **OSV** | Open Source Vulnerabilities — standardized vulnerability format |
| **CVSS** | Common Vulnerability Scoring System (v3.1 primary, v4 stored) |
| **Severity** | `NONE | LOW | MEDIUM | HIGH | CRITICAL` |
| **Base PURL** | Versionless PURL used for matching (`pkg:npm/lodash` not `pkg:npm/lodash@4.17.21`) |

## Architecture

The project maintains a **local OSV mirror** in PostgreSQL — no external API calls at query time.

```
OSV Storage (GCS) → osv-sync CLI → PostgreSQL mirror → matcher → component_vulnerabilities
```

## OSV Sync Module (`server/src/osv-sync/`)

| File | Purpose |
|------|---------|
| `cli.ts` | Entry point: `--once`, `--full-refresh`, `--backfill-affected`, `--metrics` |
| `worker.ts` | Orchestration: init from `all.zip` or incremental from `modified_id.csv` |
| `config.ts` | Env-based config: `OSV_POLL_INTERVAL_MS`, `OSV_BATCH_SIZE`, etc. |
| `parser.ts` | CSV parsing, OSV JSON parsing, `toBasePurl()`, `parsePurlComponents()` |
| `matcher.ts` | Component-to-vulnerability matching by PURL + version |
| `cvss.ts` | CVSS v3.1 vector parsing, score calculation, severity extraction |
| `repository.ts` | `osv_vulns` CRUD |
| `affected-package-repository.ts` | `osv_affected_packages` CRUD |
| `zip-processor.ts` | Streams ZIP without full extraction |
| `state.ts` | Sync state management (watermark tracking) |

## Sync Workflow

### Initialization (`runInitialization`)
1. Download `all.zip` from `https://storage.googleapis.com/osv-vulnerabilities/all.zip`
2. Stream ZIP — parse each JSON, validate, extract severity + affected packages
3. Batch upsert into `osv_vulns` and `osv_affected_packages`
4. Record max modified timestamp as watermark

### Incremental (`runIncremental`)
1. Download `modified_id.csv` — format: `modified_timestamp,path`
2. Filter by `modified >= (lastModifiedApplied - overlapWindowMinutes)`
3. Download individual JSONs from `https://storage.googleapis.com/osv-vulnerabilities/<ECOSYSTEM>/<ID>.json`
4. Replace affected packages for updated vulns

### Concurrency Control
- PostgreSQL advisory lock: `pg_try_advisory_lock(8675309)` — only one sync worker at a time
- Idempotent upsert: `WHERE raw_sha256 <> EXCLUDED.raw_sha256`

## Database Tables

### OSV Mirror (`server/src/db/schema/osv-mirror.ts`)

| Table | Key columns |
|-------|-------------|
| `osv_sync_state` | Single-row state (id=1), watermark |
| `osv_vulns` | `id` (OSV ID), `ecosystem_dir`, `raw` (JSONB), `cvss_score`, `severity_label` |
| `osv_affected_packages` | `osv_vuln_id`, `ecosystem`, `purl` (base), `purl_type`, `purl_name`, `versions` (JSONB), `ranges` (JSONB), `fixed_version` |
| `osv_sync_failures` | Parse/download failure records |

### App Vulnerabilities (`server/src/db/schema/vulnerabilities.ts`)

| Table | Purpose |
|-------|---------|
| `vulnerabilities` | Unified vulnerability records |
| `vulnerability_affected_packages` | Affected packages per vulnerability |
| `component_vulnerabilities` | Component ↔ vulnerability links with match metadata |
| `vulnerability_sync_status` | Sync status per source |

## Vulnerability Matching (`matcher.ts`)

1. Strip component PURL to base PURL via `toBasePurl()`
2. Query `osv_affected_packages` by exact base PURL match
3. Check if component version is affected:
   - **Explicit versions list**: exact match
   - **SEMVER ranges**: `isVersionAffectedBySemverRange()` using range events
   - **ECOSYSTEM ranges**: only for semver-compatible ecosystems

### Semver-Compatible Ecosystems
`npm`, `crates.io`, `Go`, `NuGet`, `Hex`, `SwiftURL`

### Range Event Semantics
- `introduced` — start of affected range
- `fixed` — end (exclusive)
- `last_affected` — last known affected (inclusive)
- `limit` — upper bound (exclusive)

### Match Result

```typescript
interface VulnMatch {
  osvVulnId: string;
  matchedBy: "purl";
  versionConfirmed: boolean;
  fixedVersion: string | null;
  ecosystem: string | null;
  packageName: string;
}
```

## CVSS Scoring (`cvss.ts`)

### Severity Extraction Order
1. `severity[]` with `CVSS_V3` → parse vector, compute score
2. `severity[]` with `CVSS_V4` → store vector (no score computation)
3. `database_specific.severity` → map text label to score
4. Heuristic: `MAL-*` IDs → CRITICAL
5. `null` if none found

### Score-to-Label Mapping
| Score Range | Label |
|-------------|-------|
| 0 | NONE |
| 0.1–3.9 | LOW |
| 4.0–6.9 | MEDIUM |
| 7.0–8.9 | HIGH |
| 9.0–10.0 | CRITICAL |

## Vulnerability Sync Service (`server/src/services/vulnerability-sync.service.ts`)

### Entry Points
- `syncComponentVulnerabilities(componentId)` — single component
- `syncProjectVulnerabilities(projectId)` — all components in project
- `syncAllComponentsVulnerabilities()` — full scan

### Flow
1. `assertMirrorReadable()` — block if `sync_status = 'full_refresh'`
2. `matcher.findVulnerabilities({ purl, name, version })` — local lookup
3. `fetchOsvRawByIds()` — load full OSV JSON from `osv_vulns.raw`
4. `convertOsvToVulnerability()` → upsert to `vulnerabilities`
5. `linkComponentVulnerability()` with `matchedBy` and `matchConfidence`

### Match Metadata
- `matchedBy`: `"purl"` or `"name_version"`
- `matchConfidence`: `"exact"` (compared under a real comparator), `"fuzzy"` (a
  comparison had to guess), or `"unconfirmed"` (the package matched but the
  version question was unanswerable)

## What counts as a finding

`src/db/findings.ts` is the single definition, and every surface that reports a
vulnerability count must use it: a finding is a link on a **current** SBOM whose
`match_confidence` is not `unconfirmed`, with advisories that describe the same
CVE collapsed to one. Do not write a new count query — the dashboard, the trend
charts and the workload page each grew their own once, and reported 195, 17 and
14 for the same workload.

Read paths must not re-derive the verdict. `vulnerability_affected_packages`
joins by package *name*, which is weaker than the canonical-key lookup the
matcher used, so re-checking there loses real findings; join it for range and
fix-version display only.

## Conventions

- Factory pattern: `createOsvSyncWorker()`, `createComponentVulnMatcher()`
- Logging: `createLogger("osv-sync:worker")`
- Lazy singletons: `getAffectedPkgRepo()`, `getMatcher()` in vulnerability sync service
- Components without PURL return no matches

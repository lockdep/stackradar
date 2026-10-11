# Artifact Hub sync

Nightly mirror of Artifact Hub's official bulk dump, plus (phase 2) the
attribution pass that maps installed Helm charts onto it.

## What it does

1. Downloads `https://artifacthub.io/api/v1/nova` — one CDN-cached JSON array
   (~18k packages, ~25 MB) with every Helm package the hub indexes: name,
   repository (url + verified/official flags), stars, and the full version
   list (`pkg`, `app`, `kube`, `deprecated`).
2. Applies it to the global `artifact_hub_packages` table with the
   stamp-and-prune shape: upsert on `(repo_name, name)` stamping
   `last_seen_at`, then delete rows the run did not stamp. One transaction.
3. Runs the attribution pass (`attribution.ts`), which examines every
   `(org, chart)` an inventory has reported and writes `chart_attributions`
   for the ones the evidence supports.

## Why the endpoint is trustworthy enough

`/api/v1/nova` is documented in Artifact Hub's OpenAPI spec under
"Integrations" — created so bulk consumers (Fairwinds Nova, Harbor
replication) would stop scraping the search API. If it ever disappears:
attributions already written keep working (the chart-repo index sync talks to
the chart repositories directly), this sync fails loudly, and the documented
per-chart search API remains as a fallback.

## Guard rails

- **Floor** (`ARTIFACT_HUB_MIN_PACKAGES_TO_APPLY`, default 10k): the prune
  makes a valid-but-truncated CDN response destructive, not just incomplete —
  it would delete live mirror rows _and cascade their attributions_. A short
  dump is refused before anything is written.
- **Byte ceiling** (`ARTIFACT_HUB_MAX_BODY_BYTES`, default 100 MB): the dump
  is buffered, not streamed — 25 MB fits the CronJob pod's 1Gi limit with
  margin. If the dump outgrows the ceiling the sync fails loudly instead of
  OOMing the pod; moving `downloader.ts` to a streaming JSON parser
  (stream-json) is the escape hatch if that becomes routine.
- **Advisory lock** (`ARTIFACT_HUB_ADVISORY_LOCK_ID`, default 8675310): the
  sync runs both as a Kubernetes CronJob and as a CLI, and the stamp-and-prune
  delete is not safe under interleaved runs. Held on a dedicated
  single-connection client so it releases on every exit path.
- **Freshness guard** (23 h) and **`recordFailure` never touching
  `last_synced_at`**, both the `epss-sync` precedent: a failed run must not
  block the next retry, and reported freshness must keep ageing.

## The prune → attribution coupling

`chart_attributions.package_id` references `artifact_hub_packages` with
`ON DELETE CASCADE`, so the mirror prune deletes attributions of packages
that vanished from the dump **mid-run**. That is safe **only** because the
attribution pass runs immediately after the mirror refresh, in the same
process, and rebuilds the attribution set from the fresh mirror. Do not
schedule the two independently — `runOnce()` (what `--once` calls) does both
under one advisory lock.

## Running it

```bash
pnpm artifacthub-sync --once      # scheduled path; respects the freshness guard
pnpm artifacthub-sync --force     # recover from a bad apply
pnpm artifacthub-sync --metrics   # last sync state

# Against a locally downloaded dump:
curl -o /tmp/nova-dump.json https://artifacthub.io/api/v1/nova
ARTIFACT_HUB_FEED_URL=file:///tmp/nova-dump.json pnpm artifacthub-sync --force
```

The scheduled path runs at `15 2 * * *` — the monolith's in-process scheduler
(`src/sync-scheduler.ts`) or a hosted deployment's own CronJob — deliberately **before** the job worker's `CHART_REPO_SYNC_CRON` (`45 4 * * *`)
so repositories the attribution pass auto-adds get their `index.yaml` synced
the same night. Move one schedule and the other has to follow.

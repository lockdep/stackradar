# `POST /internal/match` — contract v1

| | |
|---|---|
| **Status** | **Implemented** on the server (`POST /internal/match`), mounted only when `MATCH_SERVICE_KEY` is set |
| **Producer** | `server/src/routes/match.routes.ts` + `services/match.service.ts` + `schemas/match.schema.ts` |
| **Consumer** | A separate service operated by the maintainers (the public chart index), which lives in its own private repository and calls this endpoint and nothing else on the server |
| **Schema** | [`match-endpoint.json`](match-endpoint.json) — JSON Schema 2020-12 for the 200 body. Both sides validate against it |
| **Parity test** | `server/tests/integration/match/parity.test.ts` — asserts the endpoint returns exactly what the product's own findings query returns |
| **Depends on** | [ADR 0005](../adr/0005-risk-is-two-layers.md), [ADR 0007](../adr/0007-aggregate-risk-is-an-unbounded-sum.md), `server/src/db/findings.ts` (the five rules) |

This document **is the contract**. The consumer is not in this repository,
so the only thing the two sides share is this text and the JSON schema:
**change this document and the JSON schema first**, then the server, then
the consumer.

## What it is

The product's vulnerability matcher as a stateless function. The caller
sends an image's components; the server answers with **exactly the finding
set the product would show for that image** — matched by the same matcher
over the same OSV / EPSS / KEV mirror, counted and collapsed by the same
rules, each finding carrying the same generated risk contribution — and
stores nothing. The server learns nothing about charts, images or history
from this call.

The parity is enforced, not asserted:
`server/tests/integration/match/parity.test.ts` ingests an SBOM through the
ordinary upload, runs the `vulnerability_scan` job, reads
`collapsedFindings` for the image, and requires the endpoint to return the
same set of `(purlType, packageName, findingIdentity)` with the same `risk`,
`fixedVersion` and `kevListedAt` per key. If that test fails, the endpoint
is wrong, not the product.

## Request

```
POST /internal/match
X-Match-Key:   <MATCH_SERVICE_KEY>
Content-Type:  application/json

{ "components": [ { "purl": "pkg:apk/alpine/openssl@3.1.4-r5?distro=alpine-3.19.1",
                    "name": "openssl",
                    "version": "3.1.4-r5" }, … ] }
```

- `components[]` — `1 ≤ length ≤ MATCH_MAX_COMPONENTS` (default 20,000; a
  server env). Each entry is the matcher's own `ComponentInput`: `name`
  (required), `purl` and `version` (optional, nullable). A component
  without a parseable purl matches nothing and costs nothing; it is
  accepted so the caller can send an SBOM's component list verbatim and
  keep its indices.
- One call per image. The request body is capped at 10 MB by the server's
  JSON middleware.

## Responses

| Status | Body | When |
|---|---|---|
| `200` | see below; validates against `match-endpoint.json` | |
| `401` | `{ "error": "unauthorized" }` | missing or wrong `X-Match-Key` |
| `413` | `{ "error": "too_many_components", "max": <n> }` | `components.length > MATCH_MAX_COMPONENTS`; checked before validation |
| `422` | `{ "error": "invalid_body", "issues": [{ "path", "message" }] }` | Zod validation failed |
| `503` | `{ "error": "matching_unavailable" }` | the OSV mirror has never completed its initial import — the same gate the scan job defers on. Retry later; never treat as "no findings" |
| `404` | | `MATCH_SERVICE_KEY` is unset on the server: the router is not mounted at all |

### 200

```jsonc
{
  "serverVersion": "1.0.0+9f1fd70",       // package.json version + short git sha when built with GIT_SHA
  "matchedAt": "2026-09-02T10:14:03.512Z",
  "sync": {
    "osvSyncedAt": "2026-09-02T04:31:10.000Z",   // latest of incremental poll, full refresh, initial import; null on a fresh mirror
    "epssScoreDate": "2026-09-01",               // FIRST.org score date of the EPSS file last applied; null before the first sync
    "kevCatalogVersion": "2026.09.01"            // CISA catalogVersion last applied; null before the first sync
  },
  "findings": [
    {
      "component": 12,                       // index into request.components — the primary of the collapsed set
      "vulnId": "CVE-2024-5535",
      "findingIdentity": "CVE-2024-5535",    // vulnerabilities.finding_identity; "#<vulnId>" when the record stands alone
      "aliases": ["GHSA-…"],                 // every other id the set is known by, sorted; never contains vulnId
      "summary": "…",
      "severityLevel": "high",               // critical | high | medium | low | unknown
      "cvssScore": 7.5,
      "epssScore": 0.0042,
      "epssPercentile": 0.61,
      "kevListedAt": null,
      "publishedAt": "2024-06-27T11:15:00.000Z", // OSV `published`, the earliest across the collapsed set's records; null when none carries one
      "risk": 23.4,                          // vulnerabilities.risk_score — the generated column
      "packageName": "openssl",              // source package for deb / rpm / apk; the component's name otherwise
      "packageVersion": "3.1.4-r5",
      "purl": "pkg:apk/alpine/openssl@3.1.4-r5?distro=alpine-3.19.1",
      "purlType": "apk",                     // as the matcher normalises it: lower-cased, "go" → "golang"
      "fixedVersion": "3.1.5-r0",
      "confidence": "exact"                  // exact | fuzzy — never unconfirmed
    }
  ]
}
```

## Rules

1. **The response *is* the product's finding set for these components.**
   Matcher verdicts of `exact` and `fuzzy` only (rule 2 in
   `server/src/db/findings.ts`); collapsed by `(package collapse key,
   finding identity)` (rules 1, 3, 4); a stand-alone notice (`USN-`, `DSA-`,
   `RHSA-`) folded into the CVE findings it cross-references on the same
   component (rule 5). Withdrawn advisories are excluded. The collapse is
   `collapseAliases` in `server/src/lib/vulnerability-aliases.ts`, the same
   pass the workload page runs.
2. **One row per `(purlType, packageName, findingIdentity)`** per request.
   `component` is the primary the collapse chose — highest CVSS, then
   severity, then the record stating a fix, then a direct match over an
   inherited one, then a summary, then id. For a distro source package the
   primary is one of its binaries; `packageName` is the source package
   regardless.
3. **`packageName`** is `findingPackageName`'s derivation: for `deb`,
   `rpm` and `apk`, the upstream the matcher went through, else the purl's
   own `upstream=` qualifier, else the component's name; for every other
   type, the component's name.
4. **`fixedVersion`** is the collapsed set's: the primary's own when it
   states one, else the highest fix any folded record states, ordered by
   the component's version scheme — the chooser the product's fixes surface uses.
5. **`publishedAt`** is the earliest OSV `published` among the primary and
   every record folded into it: the date the vulnerability became public,
   not the date one distribution's notice did. Added 5 Sep 2026 for the
   chart index's own trending ranking; additive, so contract v1.
6. **`risk` is never recomputed by the caller.** It is the advisory's
   generated `risk_score` (ADR 0005). A caller aggregates by ADR 0007's
   arithmetic only: sum, worst band.
7. **`sync` is what the caller records next to the numbers.** A score is
   only comparable with another if their inputs are known.
8. **Order** is `risk DESC, vulnId ASC, packageName ASC, component ASC` —
   total, so equal inputs give equal output.
9. **Nothing is stored.** The server logs the component count, finding
   count and duration per call, never the components.

## Change rule

Fields are **added**, never renamed or removed, without bumping the version
in the JSON schema's `$id` and `title` and updating both apps' tests. The
JSON schema sets `additionalProperties: false`, so an added field must land
in `match-endpoint.json` before it lands in the response; the server's shape
test (`tests/integration/match/endpoint.test.ts`) and the consumer's own
fixture test against the schema both fail otherwise.

## Reachability and keys

- **Own key.** `MATCH_SERVICE_KEY`, compared in constant time, sent as
  `X-Match-Key`. Not `INTERNAL_SERVICE_KEY`: that one lets a caller assert a
  user identity in headers, and the consumer must never hold it. When the
  env is unset the router is not mounted and the server logs one line
  saying so at startup. A community install that does not run a consumer
  leaves it unset and the endpoint does not exist.
- **Not public.** A deployment exposes only the exact `/v1` scanner paths
  to the internet; `/internal/*` must stay reachable only from the network
  the consumer runs in (an ingress allow-list plus a NetworkPolicy in
  Kubernetes). The key is a second lock, not the only one.

---

# Sibling: `GET /internal/chart-delta` (chart index → product)

Added 2026-09-17. The same two services, the same pattern, **the opposite
direction**: the chart index serves it and the product's server calls it
(`lib/chart-index-client.ts`, configured by `CHART_INDEX_URL` +
`CHART_INDEX_DELTA_KEY`; both unset — the default — and nothing is called).
It is a sibling of the match endpoint rather than its own document because
the two are one trust boundary — two services that share no database, each
holding one narrow key to one read on the other.

## What it is

The chart index renders public charts on their default values, inventories
the images, and keeps a finding delta between the versions of a chart it
holds (`chart_version_deltas`). The product has releases it could not
measure a newer chart for — no sibling release runs it and the platform has
not rendered it — and may then only say "a newer chart exists". This read
lets the same row say what the index measured:
"upgrading to 68.2 removes 212 findings".

It is evidence of a third kind and the product labels it so
(`FixListItem.evidence: "chart-index"`): measured, on the chart's **default
values**, not on this cluster's. A release that overrides an image tag runs
something the index did not render.

## Request

```
GET /internal/chart-delta?repoUrl=<chart repository URL>&chart=<name>&from=<version>&to=<version>
X-Delta-Key: <DELTA_SERVICE_KEY>
```

Nothing a customer owns is in it: a public repository URL, a chart name and
two version strings. No org, no cluster, no image. Each parameter is at
most 512 characters; a missing one is `422`.

## Responses

`200`, measured — `summary` is the `DeltaSummary` shape both apps already
share through `delta-cases.json`:

```json
{
  "measured": true,
  "chart": { "repoUrl": "https://…", "name": "kube-prometheus-stack" },
  "from": "65.1.0",
  "to": "68.2.0",
  "summary": { "resolved": 212, "introduced": 3, "unchanged": 19, "resolvedKev": 1,
               "introducedKev": 0, "resolvedHigh": 40, "riskBefore": 900,
               "riskAfter": 120, "riskChange": -780 },
  "imageMoves": [{ "registry": "quay.io", "repository": "prometheus/prometheus", "from": "v2.54.1", "to": "v3.1.0" }],
  "imagesAdded": [],
  "imagesRemoved": [],
  "computedAt": "2026-09-17T04:12:00.000Z"
}
```

`200`, not measured — the common answer, and not an error:

```json
{ "measured": false, "reason": "from-not-indexed" }
```

`reason` is one of `chart-not-indexed`, `from-not-indexed`, `to-not-indexed`,
`delta-not-computed`. The index keeps the latest version of every chart and
the previous major of the selected ones, so most `(from, to)` pairs a
customer's release implies are **not** answerable today. The index never
substitutes a neighbouring version.

`401` wrong or missing key · `404` while `DELTA_SERVICE_KEY` is unset (a host
that has not opted in has no such route) · `422` a missing or over-long
parameter · `503` the read failed.

## Rules

1. Repository URLs compare without a trailing slash and case-insensitively.
2. The product treats every non-measured outcome — a refusal, a timeout
   (3 s), a 5xx, an unset `CHART_INDEX_URL` — identically: the row stays
   unmeasured, as it was before this endpoint existed.
3. The product caches an answer for an hour per `(repoUrl, chart, from, to)`,
   refusals included; it never caches a transport failure.
4. `never cached, never crawled`: `Cache-Control: no-store`,
   `X-Robots-Tag: noindex`, and `/internal` is disallowed in `robots.txt`.

## Reachability and keys

- **Own key.** Presented as `X-Delta-Key`; on the server it is
  `CHART_INDEX_DELTA_KEY` + `CHART_INDEX_URL` (API and worker). It is a
  different key from `STATUS_SERVICE_KEY`, which belongs to the product's
  *client* and opens the chart index's admin status read.
- **Reachability** is the consumer's concern: its network policy has to
  admit the product's server pods for this read.

---

# Sibling: `POST /internal/known-images` (chart index → product)

Added 2026-09-17. Same caller, same direction and **the same key** as the
match endpoint (`X-Match-Key`): the consumer already holds it, and what it
opens here is one idempotent insert of public facts. Mounted with the match router — absent while
`MATCH_SERVICE_KEY` is unset.

## What it is

The chart index tells the product which **public** images it has inventoried
and what their ordered layers are. The product stores each whole chain under
its hash (`known_layer_prefixes`) and uses it for two lookups over a
customer's image: *its first k layers are a known image* → that image is its
base (`lib/base-image.ts`, signal 2); *all its layers are a known image* →
it is third-party (`lib/image-control.ts`, `known-image`).

Nothing about a customer is on either side of this call, and the table it
fills is never written from an upload (ADR 0006): a customer's own golden
bases are found by comparing that org's images with each other at read time.

## Request

```json
{ "images": [ { "imageRef": "docker.io/grafana/grafana:11.2.0",
                "diffIds": ["sha256:…", "sha256:…"] } ] }
```

1–500 images per call; `imageRef` ≤ 1024 characters, the ref a reader would
type (never a bare digest); 1–127 `diffIds`, each `sha256:` + 64 hex, in
layer order — the image config's `rootfs.diff_ids`.

## Responses

`200 { "received": 500, "recorded": 37 }` — `recorded` counts new rows; a
chain already known under that ref is not an error. `401` wrong or missing
key · `422 { error: "invalid_body", issues }`.

## Rules

1. Idempotent: `(chain hash, imageRef)` is the key, `ON CONFLICT DO NOTHING`.
   A caller that crashes between the POST and its own bookkeeping repeats it.
2. A tag that moved is two rows under two hashes; two tags of one image are
   two rows under one hash. Both are correct and neither is cleaned up.
3. The server side is implemented; the consumer does not call it yet.

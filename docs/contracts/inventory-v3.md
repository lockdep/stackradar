# `POST /v1/inventory` — payload contract v3

| | |
|---|---|
| **Status** | **Implemented** on both sides |
| **Implemented by** | `stackradar-scanner` `src/lib/scan.ts` `buildInventory` (producer), `server/src/schemas/inventory.schema.ts` + `scanner.controller.ts` + `inventory.repository.ts` (consumer) |
| **Supersedes** | v2 (document removed; never deployed to a customer). v3 replaced it outright — there is no dual-shape acceptance window |
| **Depends on** | [ADR 0004](../adr/0004-image-as-the-unit-of-identity.md), scanner `workload-owner-attribution.md` |

This is the seam between the two repos. Both sides encode it, so **change this
document first**.

## What changes from v2, and why

Three changes, all from one finding: the agent used to derive Helm context from
**pod** labels and annotations only, and on a real cluster the pod is the object
in the chain that usually does *not* carry that context. It now reads the pod's
controller as well.

### 1. `releases[].source` is removed

v2 carried `source: "helm" | "argocd" | "flux"`, with the latter two reserved
and unproducible. That reservation was the mistake. ArgoCD commonly deploys
*via* Helm, so a workload legitimately has **both** at different layers, and a
single discriminator forces a choice between two true answers:

- `kube-prometheus-stack` on the reference cluster is a Helm release (chart
  `kube-prometheus-stack-82.18.0`) **and** an ArgoCD app (`targetRevision:
  82.18.0`, from the prometheus-community repo). Fourteen of its twenty-three
  attributed workloads are in that position — the majority.
- The chart version is what a CVE report cites. The Argo app is where the fix is
  made. Discarding either loses half of the remediation path.

Every row in `releases[]` is therefore a Helm release, full stop. Flux is not an
exception: it installs *through* the Helm SDK, so a `HelmRelease` CR produces a
genuine release row **and** an application row with `tool: "flux"`.

### 2. `applications[]` is added — the delivery layer as its own relation

A sibling array to `releases[]`, and a second, independent reference on each
workload. Two layers, two questions:

| | `releases[]` | `applications[]` |
|---|---|---|
| Answers | "what chart packaged this, at what version" | "what delivers this, and where do I change it" |
| Key | `(clusterId, namespace, name)` — the **release's** namespace | `(clusterId, namespace, name)` — the **app object's** namespace, e.g. `argocd` |
| Derived from | pod + controller labels | `argocd.argoproj.io/tracking-id` on the controller, then the `Application` object |

### 3. `ownerMetadataCollected` is added

`false` when the agent could not read the pods' controllers at all — RBAC
absent, or `scanner.resolveWorkloadOwners` switched off. Without it, "no chart
claims this workload" and "we were not allowed to look" are the same report, and
the UI states the first while the second is true. That is precisely what made
this class of bug invisible for a release. Same reasoning as `namespaces[].labels`
being `null` rather than `{}`.

## Shape

```jsonc
{
  "version": 3,
  "reportedAt": "2026-08-16T09:14:22.113Z",   // producer clock; advisory only
  "informerSynced": true,
  "ownerMetadataCollected": true,             // false = the agent could not look

  "releases": [                               // Helm only. No `source` field.
    {
      "name": "kube-prometheus-stack",
      "namespace": "monitoring",    // the RELEASE's namespace, not the workload's
      "chartName": "kube-prometheus-stack",
      "chartVersion": "82.18.0",
      "appVersion": "82.18.0",      // the APP's version. Equal here, not derived
      "repoUrl": "https://prometheus-community.github.io/helm-charts"
    }
  ],

  "applications": [                           // new in v3
    {
      "name": "kube-prometheus-stack",
      "namespace": "argocd",        // the APPLICATION's namespace
      "tool": "argocd",             // argocd | flux
      "repoUrl": "https://prometheus-community.github.io/helm-charts",
      "targetRevision": "82.18.0",  // where the fix is made, for an Argo user
      "chart": "kube-prometheus-stack",
      "path": null,                 // path or chart, not both
      "destinationNamespace": "monitoring"
    }
  ],

  "scanFailures": [                         // optional; additive — see below
    {
      "imageDigest": "sha256:4748…",       // must be a digest this report's containers carry
      "code": "registry_auth",              // registry_auth | registry_rate_limited | scan_error
      "registryHost": "registry.digitalocean.com"
    }
  ],

  "namespaces": [
    {
      "name": "monitoring",
      "labels": { "environment": "prod" },   // null = not collected; {} = none
      "workloads": [
        {
          "kind": "StatefulSet",             // null = could not resolve
          "name": "alertmanager-kube-prometheus-stack-alertmanager",
          "release":     { "name": "kube-prometheus-stack", "namespace": "monitoring" },
          "application": { "name": "kube-prometheus-stack", "namespace": "argocd" },
          "runningPods": 1,
          "firstStartedAt": "2026-07-02T10:00:00.000Z",
          "labels": { "app.kubernetes.io/part-of": "kube-prometheus-stack" },
          "containers": [
            {
              "name": "alertmanager",
              "init": false,
              "imageRef": "quay.io/prometheus/alertmanager:v0.28.1",
              "imageDigest": "sha256:2f1c…",
              "imageTag": "v0.28.1",         // null when digest-pinned
              "registry": "quay.io",
              "repository": "prometheus/alertmanager",
              "runningPods": 1
            }
          ]
        }
      ]
    }
  ]
}
```

## Field semantics

| Field | Type | Notes |
|---|---|---|
| `version` | `3`, required | Rejected with 400 if not 3. See [Versioning](#versioning) |
| `reportedAt` | ISO 8601, required | **Advisory.** The server stamps rows with its own clock — producer clocks skew |
| `informerSynced` | bool, required | See [The empty-report hazard](#the-empty-report-hazard) |
| `ownerMetadataCollected` | bool, required | `false` = controller metadata was not read. Surfaced back as the `owner_metadata_not_collected` warning; see [Distinguishing "none" from "unknown"](#distinguishing-none-from-unknown) |
| `releases[].name` | string | See [Where release identity comes from](#where-release-identity-comes-from) |
| `releases[].namespace` | string | The release's own namespace — **not** necessarily the workload's. Only `meta.helm.sh/release-namespace` can prove the difference, and that annotation lives on the controller |
| `releases[].chartName` / `chartVersion` | string \| null | Split from `helm.sh/chart` (or pre-3.0 `chart`), which is `<name>-<version>` with no delimiter of its own |
| `releases[].appVersion` | string \| null | From `app.kubernetes.io/version`. **Distinct from `chartVersion` even when equal** — see below |
| `releases[].repoUrl` | string \| null | `null` means unknown. Only an ArgoCD/Flux source object can supply it |
| `applications[].name` / `namespace` | string | Natural key. `namespace` is the app object's own, not its destination |
| `applications[].tool` | `argocd` \| `flux` | Unknown values are rejected rather than stored |
| `applications[].repoUrl` / `targetRevision` / `chart` / `path` / `destinationNamespace` | string \| null | All `null` when derived from the tracking annotation alone. `chart` and `path` are mutually exclusive in ArgoCD's own model |
| `namespaces[].labels` | object \| null | **`null` (not collected) is different from `{}` (collected, none present).** |
| `workloads[].kind` | string \| null | Resolved from `ownerReferences`. `null` when the chain dead-ends — never guessed, and never the literal `"Pod"` unless the pod genuinely has no owner |
| `workloads[].release` | object \| null | Natural-key reference into `releases[]`. A dangling reference is a 400 |
| `workloads[].application` | object \| null | Natural-key reference into `applications[]`. A dangling reference is a 400, for the same reason |
| `workloads[].labels` | object \| null | Pod labels **merged over** controller labels, pod winning. This is how `app.kubernetes.io/part-of` reaches the client for a workload whose pod template never carried it |
| `workloads[].runningPods` | int ≥ 1 | Pods **observed**, not `spec.replicas` |
| `containers[].init` | bool | Init containers run, so their images can be vulnerable, but they do not serve traffic |
| `containers[].imageTag` | string \| null | `null` for a digest-pinned deployment. Never invent `"latest"` |
| `containers[].runningPods` | int ≥ 1 | Not always the workload's count — see [Container identity](#container-identity-includes-the-digest) |
| `scanFailures[]` | array, optional | Why a digest in this report has no SBOM. Display-only; omitted when every scan succeeded. See [Scan failures](#scan-failures-are-display-only-classification) |
| `scanFailures[].imageDigest` | string | References a digest present in this report's containers — the producer filters out failures for digests no longer running |
| `scanFailures[].code` | string | `registry_auth` \| `registry_rate_limited` \| `scan_error`. **Open set**: the server stores an unknown code and the UI renders it as `scan_error`, so a newer scanner can add one without a server release |
| `scanFailures[].registryHost` | string \| null | Host only, e.g. `registry.digitalocean.com`. **Never raw syft stderr** — stderr carries full registry URLs and API responses, and this lands in a shared UI |

### Where release identity comes from

**The pod and its controller, merged — with the pod winning any key both carry.**

v2 said "labels, primarily", and gave two reasons the annotations were useless:
nothing propagates `meta.helm.sh/release-*` into the pod template, and a chart
applied by ArgoCD has them on nothing at all. The first reason was a fact about
*where the agent was looking*, not about the cluster. Helm does write those
annotations — on the object it applies. Reading one hop up recovers them.

Evidence is gathered from the union and then judged. Three rules, each measured
against the [recommended labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/)
spec:

**Evidence must be positive.** v2 had `managed-by` veto: "when it names a
controller other than Helm, `instance` is that controller's grouping key and not
a release name". The instinct was right and the mechanism was wrong. The spec
defines `app.kubernetes.io/managed-by` as "the tool being used to manage the
**operation** of an application" — so `managed-by: prometheus-operator` on a
StatefulSet that Helm packaged is a true statement, not a contradiction, and it
hid two whole releases on the reference cluster. The label is also absent on
three quarters of a typical fleet, so any rule of the form "trust this only when
managed-by says Helm" starts by discarding the majority.

A release is claimed only on **positive** evidence — a `meta.helm.sh/release-name`
annotation, a `helm.sh/chart` label, `heritage: Helm`, a `chart` label that
parses as `<name>-<version>`, or `managed-by: Helm`. `managed-by` is one way to
say Helm and never a way to say not-Helm.

**Unprefixed labels are corroborated before they are trusted.** The spec is
explicit that "labels without a prefix are private to users", and `release`,
`chart` and `heritage` are all unprefixed. `release: stable` as somebody's
channel marker is a legitimate use of that key. So `release` is read as a
release name only when the same object also carries `heritage: Helm`,
`helm.sh/chart`, or a well-formed `chart` label.

**`instance` is the last source for a name.** The spec defines
`app.kubernetes.io/instance` as "a unique name identifying the **instance** of
an application", with `mysql-abcxyz` as its example. Helm's convention is to set
it to the release name, but prometheus-operator is being *correct* when it
stamps `instance: kube-prometheus-stack-alertmanager` on one instance of the
`kube-prometheus-stack` release — and reading that as a release name splits one
release into three. The order is:

1. `meta.helm.sh/release-name` (annotation — Helm wrote it, so it is a fact)
2. `release` — **only** under corroboration
3. `app.kubernetes.io/instance`
4. `release`, uncorroborated, as a last resort

**The umbrella chart names the release.** Unchanged from v2: every pod of one
release carries its *own* subchart in `helm.sh/chart`, so "last one wins" makes
`chartName` depend on informer ordering. Prefer the entry whose `chartName`
equals the release name; failing that, any named chart over an unnamed one.

### `appVersion` is not a version anything may be computed from

`appVersion` comes from `app.kubernetes.io/version`, which the spec defines as
"the current version of the application". On 5 of the 15 attributed releases on
the reference cluster it is byte-identical to the chart version — `cert-manager
v1.19.2` legitimately, but also `kube-prometheus-stack-operator 82.18.0`, which
is the chart's version stamped where the app's belongs. Nothing detects the
difference from labels alone.

So: keep collecting it, keep it distinct from `chartVersion` even when equal, and
**never derive one from the other**. The remediation chain *newer chart → newer
appVersion → newer image tag* has its middle link in a label charts get wrong;
the measured image digest is what proves a fix landed.

### Distinguishing "none" from "unknown"

Three fields carry this distinction, and all three exist because collapsing it
turns a permissions failure into a confident false statement:

| Field | `null` / `false` means | The alternative it must not collapse into |
|---|---|---|
| `namespaces[].labels` | not collected (RBAC) | `{}` — collected, none present |
| `workloads[].kind` | `ownerReferences` did not resolve | `"Pod"` — a genuinely bare pod |
| `ownerMetadataCollected` | the controllers were not read | a workload no chart manages |

The response returns `owner_metadata_not_collected` when the last is `false`, and
the UI says "controller metadata not collected — grant `deployments: get`"
instead of "No Helm release claims these workloads".

### Container identity includes the digest

Unchanged from v2. A container entry is keyed `(workload, containerName,
imageDigest)`, **not** `(workload, containerName)`.

During a rollout a Deployment legitimately runs two digests at once, and the
honest report is two entries for `api` — one on the old digest with 1 pod, one on
the new with 2. Hence a per-container `runningPods` that may not sum to the
workload's. This is the state remediation verification reads: "is the fix
actually deployed?" is exactly "does any container row still reference the old
image", and a model keyed only on container name would report the fix complete
while the vulnerable digest is still serving traffic.

### Scan failures are display-only classification

Added to v3 as an **additive optional field** — a report without it is still
valid, and a server that predates it ignores it (unknown fields are ignored by
contract), so there is no version bump: the shape is a strict superset.

After a failed scan the agent classifies syft's stderr — `401` / `403` /
`UNAUTHORIZED` / `DENIED` → `registry_auth`, `TOOMANYREQUESTS` / `429` →
`registry_rate_limited`, anything else → `scan_error` — and reports the code
with the registry host on the next inventory cycle. Riding the inventory rather
than a dedicated endpoint is deliberate: a failure that persists across one
cycle is exactly the kind worth surfacing, and the transient ones filter
themselves out. Two constraints, both load-bearing:

- **Retry policy does not change.** Classification is display-only. Every syft
  failure still retries on the cooldown — a 401 can be an expired token — and
  parsing stderr is fragile across syft versions, which is contained by the
  image pinning its syft: patterns are validated per release, and anything
  unmatched degrades to `scan_error`, never to a misclassification.
- **Raw stderr never crosses the wire.** Only `code` + `registryHost` +
  `imageDigest`; stderr carries full registry URLs and API responses.

The server persists the failure onto the `(cluster, digest)` image row
(`images.last_scan_error_code` / `_host` / `_at`) and **clears it on the next
successful SBOM upload for that digest**. The inventory path never clears it —
a scanner restart reports with an empty failure memory, and that absence must
not erase a still-true error. A failure whose digest stops running leaves the
report (the producer filters to reported digests) and ages out with the image
row.

## Semantics

**Full set replacement, per cluster.** Unchanged and non-negotiable: the report
is everything running, and anything absent from it is deleted. The cluster comes
from the API key's `clusterId`, never from the body.

**Idempotent.** Re-sending an identical report is a no-op beyond `lastSeenAt`.

**Unknown fields are ignored,** so a newer scanner can add fields without
coordinating a server release. Do not use `.strict()` on the Zod schema.

### The empty-report hazard

Unchanged from v2. A full-set replacement with an empty body deletes the
cluster's entire inventory, and a broken informer that syncs to zero pods
produces exactly that body.

- The scanner **must not** send a report before its informer has completed
  initial sync, and must set `informerSynced: false` if it does.
- The server **rejects** (400) a report with zero namespaces, or with
  `informerSynced: false`, without touching stored rows.
- A genuinely empty cluster is represented by *no report*, ageing out via
  `lastSeenAt` rather than being truncated in one step.

### Size limits

| Limit | Value | On breach |
|---|---|---|
| Total containers | 10,000 | 400 |
| Request body | 8 MB | 413 |

**A report that exceeds them is rejected whole** — the failure mode being
avoided is recording a truncated cluster as fully discovered.

## Versioning

| Situation | Behaviour |
|---|---|
| v2 scanner → v3 server | 400 with a message naming the minimum chart version. The scanner logs it once per interval and keeps scanning — inventory is a progress signal, and losing it must never stop SBOM upload |
| v3 scanner → v2 server | 400. Existing client code already treats 400 and 404 as "control plane out of step, skip" |

`X-Scanner-Version` is sent on every request, and the server names the running
version in the error rather than making the operator find it.

Since StackRadar is not in production there is **no dual-shape acceptance
window**. v3 replaces v2 outright, and `helm_releases.source` is dropped as a
schema replacement rather than a data migration — the same call v2 made for v1.

## Response

```jsonc
{
  "accepted": { "namespaces": 4, "workloads": 37, "containers": 41, "releases": 6, "applications": 5 },
  "warnings": [
    { "code": "kind_unresolved", "count": 12 },
    { "code": "namespace_labels_not_collected", "count": 4 },
    { "code": "owner_metadata_not_collected" }
  ]
}
```

Counts let the scanner log what landed rather than what it sent. `warnings` is
how a degraded-but-working agent becomes visible as data rather than as a log
line.

## Acceptance criteria

- [x] Zod schema and scanner builder derive from this document; both reject
      `version !== 3`
- [x] `releases[]` has no `source` field, and `helm_releases` has no `source`
      column
- [x] A workload delivered by Argo *and* packaged by a chart carries both
      references, and neither layer can leak into the other — tested with
      `kube-prometheus-stack`, which is legitimately both
- [x] A workload referencing an application absent from `applications[]` is a
      400, matching the rule for releases
- [x] `ownerMetadataCollected: false` produces `owner_metadata_not_collected`
      and is stored on the cluster, so the UI can tell "no chart" from "we could
      not look"
- [x] `appVersion` and `chartVersion` stay distinct even when equal, and no code
      path derives one from the other
- [x] Container identity includes `imageDigest`; a mid-rollout Deployment
      reports two entries for one container name
- [x] `null` vs `{}` is preserved end to end for `namespaces[].labels`
- [x] Reports with zero namespaces or `informerSynced: false` are rejected
      without mutating stored rows
- [x] Over-limit reports are rejected whole; no partial application
- [x] `clusterId` is taken from the API key and never from the body
- [x] Unknown fields are ignored
- [x] A v2 scanner receives a 400 naming the minimum chart version, and
      continues uploading SBOMs
- [x] `scanFailures[]` is optional and additive: a report without it parses,
      an older server ignores it, and no version bump was needed
- [x] Raw syft stderr never crosses the wire — the schema accepts only
      `code`, `registryHost` and `imageDigest`, and the classifier unit tests
      cover the real 25 Aug log samples (DO 401, ECR TOOMANYREQUESTS) plus an
      unrecognised error falling back to `scan_error`
- [x] A successful SBOM upload clears the stored failure; an inventory report
      never does

Server coverage is `tests/integration/inventory/report-inventory.test.ts`;
producer coverage is `src/lib/inventory.test.ts` and `src/lib/owner-cache.test.ts`
in the scanner.

## Open items

- **Should init containers count toward workload risk?** They run, so their
  images can be vulnerable, but they are not serving traffic. The flag is in the
  contract; the ranking decision belongs with
  [risk-ranking.md](../proposals/risk-ranking.md).
- **`tool: "flux"`** is accepted but unproducible: the agent reads ArgoCD's
  tracking annotation and `Application` objects, not `HelmRelease` or
  `Kustomization` CRs. Rejecting unknown values rather than storing them is
  implemented on both sides.

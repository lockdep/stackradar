# Database Schema

This documents the schema **as built**, after the
[ADR 0004](../../../docs/adr/0004-image-as-the-unit-of-identity.md) cutover and
the [ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md) scoping of
images to clusters. `projects`, `discovered_workloads` and `sboms.isCurrent`
are gone; the model is
`clusters → namespaces → workloads → workload_containers` plus cluster-scoped
`images`, `helm_releases` and the SBOM tree hanging off `images`.

## Auth & Identity

### `users`

Stores user profiles, managed by Auth.js. Contains basic info from OAuth providers (name, email, image). This is the root identity table — many other tables reference it.

`demo` marks the shared **demo visitor**, set only by `scripts/seed-demo.ts`. Every non-read internal request
from that user is refused with `403 read_only_demo` in `requireAuth`
(`middleware/auth.ts`) — the routes with no org context, which
`organizations.demo` below cannot cover.

`trial_consumed_at` (cloud) is stamped by the Stripe webhook when a
subscription this user checked out first enters `trialing`; a later checkout
by the same user carries no trial period (`cloud/billing/billing.controller.ts`).

- **Referenced by:** `org_members`, `org_invites`, `api_keys`

### `organizations`

Represents a team or company. Owns clusters, API keys, and jobs. Has a subscription plan (`free`/`pro`/`team`) and optional Stripe integration. Supports soft-delete via `deletedAt`.

`system` marks the one StackRadar-owned **platform org** the candidate-chart
scanner writes under;
`clusters.system` marks its cluster. No member can join a system org and no
API key can be minted for a system org or cluster — enforced in
`organization.repository.ts` / `cluster.repository.ts`, not by convention.

`demo` marks the public **demo org**, set only by `scripts/seed-demo.ts`. Every non-read internal request
scoped to it is refused with `403 read_only_demo` in `requireOrg`; API-key
ingest into its cluster is untouched. No member can be added except by the
seed (`addOrgMember` refuses), and `db/tenant-orgs.ts` keeps it — with the
system org — out of the platform metrics sweeps. It sits on plan `team` with
no Stripe customer.

- **Referenced by:** `org_members`, `org_invites`, `api_keys`, `namespaces`, `workloads`, `workload_containers`, `helm_releases`, `jobs`

### `org_members`

Many-to-many join table linking **users** to **organizations** with a role (`owner`, `admin`, or `member`). Composite PK on `(userId, orgId)`.

- **References:** `users.id`, `organizations.id`

### `org_invites`

Tracks pending invitations to join an organization. Stores the invitee's email, the assigned role, a unique invite token, and an expiration timestamp.

- **References:** `organizations.id`, `users.id` (the inviter)

### `api_keys`

API keys used by the StackRadar scanner agent to authenticate from inside a Kubernetes cluster. Each key belongs to an organization and is created by a user, and may be **cluster-scoped** via `clusterId`.

Heartbeat (`/v1/heartbeat`) and inventory (`/v1/inventory`) require a cluster-scoped key. SBOM upload does **not**: ingesting an image and its SBOM is a fact about public bytes, and a cluster-scoped key is required only to _link_ that image to a workload — which is the part that writes tenant data. That distinction is what lets an SBOM exist with no cluster behind it.

The actual key is stored as a SHA-256 hash with a prefix for identification.

- **References:** `organizations.id`, `users.id`, `clusters.id` (optional, when cluster-scoped)

---

## Kubernetes Inventory

The containment chain the scanner reports through `POST /v1/inventory`
([contract](../../../docs/contracts/inventory-v3.md)). Each report is a **full
set replacement** for one cluster: rows in the report are stamped with the
report's timestamp, and anything left carrying an older stamp is deleted. The
cluster comes from the API key, never from the body.

The `clusters` row itself also carries what the scanner reports _about_ the
cluster: `scanner_version` / `scanner_last_seen_at` (from `X-Scanner-Version`,
written by the auth middleware on every keyed request),
`owner_metadata_collected` (from the inventory report; null = never reported),
`first_inventory_at` (set once by the first inventory report and never moved;
null = never reported — the start of what we have observed, which is what
makes an exposure duration exact or a lower bound, `lib/exposure.ts`),
and `kubernetes_version` (the `gitVersion` from the `X-Kubernetes-Version`
heartbeat header; null = unknown, and an absent header never erases a stored
value — an older scanner must not delete knowledge). `kubernetes_version`
feeds `lib/kube-constraint.ts`, which warns when a suggested chart version's
`kubeVersion` range excludes the cluster — and says nothing whenever either
side is unknown.

### `namespaces`

A Kubernetes namespace, keyed `(clusterId, name)`. This is the "folder" the workloads list browses by — a real entity rather than the `projects` row with `type: "group"` it replaced, so browsing is a plain join instead of a recursive tree walk, and a namespace with **zero workloads** is representable at all.

`labels` distinguishes `null` (not collected — the agent lacks namespace-read RBAC) from `{}` (collected, none present). Collapsing the two would make a permissions failure indistinguishable from an unlabelled namespace.

- **References:** `organizations.id`, `clusters.id` (both `ON DELETE CASCADE`)
- **Referenced by:** `workloads`

### `workloads`

A Deployment, StatefulSet, DaemonSet, CronJob or bare Pod. Identity is `(namespaceId, kind, name)`, enforced by **two partial unique indexes** — Postgres treats NULL as distinct in a composite unique constraint, so one index covers resolved kinds and another covers unresolved ones.

`kind` is nullable and is resolved from the pod's `ownerReferences` by the scanner. When the owner chain dead-ends the honest answer is "unknown", never the literal `"Pod"`: a guessed kind becomes a wrong `kubectl set image deployment/x` for a StatefulSet.

`releaseId` is nullable because most clusters run plenty of workloads no chart manages, and those must appear as a visible "unmanaged" group rather than disappear from a release-grouped view. `ON DELETE SET NULL`, so losing the release does not delete the workload — which is still running.

`applicationId` is the same shape for the **delivery** layer, and independent of `releaseId`: ArgoCD commonly deploys _via_ Helm, so a workload legitimately has both, and neither is derivable from the other. The scanner itself is the mirror case — a chart with no GitOps tool above it.

`labels` holds the allowlisted pod labels **merged over the controller's**, the pod winning any shared key. That merge is why `app.kubernetes.io/part-of` is usually present even for a workload whose pod template never carried it, which is what lets the UI sub-group the unattributed bucket by suite without a new column.

- **References:** `organizations.id`, `namespaces.id`, `helm_releases.id` (nullable, `SET NULL`), `gitops_applications.id` (nullable, `SET NULL`)
- **Referenced by:** `workload_containers`

### `workload_containers`

The running thing: one container of one workload, on one image. Carries every **deployment** fact — the tag that was asked for, the ref, how many pods are running it, when first seen.

**Identity includes `imageId`**: `(workloadId, name, imageId)`. During a rollout a Deployment legitimately runs two digests at once, and the honest record is two rows for `api` — one on the old digest, one on the new. A model keyed only on container name cannot represent a half-finished rollout, so it would report a fix as deployed while the vulnerable digest is still serving traffic. That state _is_ the answer to "is the fix live", which is why the digest is in the key rather than tolerated as an edge case.

`imageTag` is `NULL` for a digest-pinned deployment — there is no tag, and inventing `"latest"` labels every distinct image identically. `init` flags init containers, which run (so their images can be vulnerable) but do not serve traffic.

`image_pull_secrets` is the **names** of the pull Secrets on the pods running the container, as the inventory reported them — never their contents. It exists for one reader: the Coverage card's registry-auth remediation, which pre-fills `scanner.imagePullSecretNames` from it. `NULL` (not reported — a scanner older than the field) is different from `{}` (reported, the pods carry none); the second sends the operator to a static credential or workload identity, the first to a `kubectl` lookup, and collapsing them would pick for them.

`imageId` is `ON DELETE RESTRICT`: an image with a container on it is in use.

- **References:** `organizations.id`, `workloads.id`, `images.id` (`RESTRICT`)

### `workload_container_history`

The past of `workload_containers`, as **intervals**: this _slot_ — a workload plus a container name — ran this digest from one inventory report (`started_at`) until another (`ended_at`, `NULL` = current).

`workload_containers` cannot answer "what did `prod/web` × `api` run yesterday": it is keyed on the digest, so a move is one row deleted and one inserted, and the inventory write path deletes the before-state in the same transaction. This table is what remembers. The live table is deliberately untouched — every read path, tenancy check and the coverage `LEFT JOIN` depend on it meaning "what runs now", and a `gone_at` column there would turn each of them into "and not gone".

A **transition** is derived — an interval closed and another opened on the same slot — never stored. A half-finished rollout is two open intervals; a canary that never completes stays two; a `:latest` that silently re-pulled is a closed interval and an open one with equal tags. The slot key (`namespace`, `workload_name`, `container_name`) leaves the workload **kind** out, so an RBAC change that resolves a `null` kind is not reported as a deploy.

Written only by `inventoryRepository.replaceForCluster`, inside the report's transaction (`container-history.repository.ts`): the before-state is read before the upsert destroys it, the intervals are reconciled against the open ones afterwards, and the container events the diff produces (`lib/container-slots.ts`) are appended to `activity_events` in the same commit. A cluster whose rows predate the table gets its running containers backfilled as open intervals dated from `first_seen_at`, with no events.

Naming facts are denormalised exactly as `issues` does it, so a row outlives its referents: `workload_id` and `image_id` are `SET NULL` (workloads are pruned and recreated with new ids; the image GC must not erase history). The cluster reference **cascades**, following the inventory convention — `activity_events` already cascades from `clusters`, so a deleted cluster's feed is gone either way. Retention ages on `ended_at`, never `started_at`: an open interval is current and is never swept (`containerHistoryRepository.deleteBeyondPlanWindows`, on the plan clock with the other history tables).

Its second reader is **exposure duration** (`lib/exposure.ts`, `services/exposure.service.ts`): a finding's presence on a slot is the unbroken run of intervals whose digests all carry it, so a rollout between two affected digests does not reset the clock. `wc_history_slot_started_idx` serves that read (every interval of a set of slots, open and closed). An interval whose `image_id` went `NULL` says which digest ran but not what was in it, and the walk stops there with a lower bound. Exposure is a displayed fact and is in neither layer of the risk score.

- **References:** `organizations.id`, `clusters.id` (composite with `org_id`, CASCADE), `workloads.id` (SET NULL), `images.id` (SET NULL)

### `helm_releases`

A Helm release — the **packaging** layer — keyed `(clusterId, namespace, name)`. Built from labels and annotations on the pod **and its controller**, and it makes release a grouping axis over the same workload rows, alongside namespace (the folder view), application (the delivery view) and image (the remediation view).

There is deliberately **no `source` column**. Every row here is a Helm release; the delivery layer is `gitops_applications`. Flux is not an exception — it installs _through_ the Helm SDK, so a `HelmRelease` CR produces a genuine row here **and** an application row with `tool: "flux"`.

Three traps the key and columns encode:

- `namespace` is the **release's** namespace, from `meta.helm.sh/release-namespace`, never the workload's. A chart may deploy resources into other namespaces, and keying on the workload's silently splits one release into several.
- A release name is not unique across namespaces, so the key is the triple.
- A chart name is not unique across repositories — several repos publish `nginx`. `repoUrl` is nullable because pod metadata cannot supply it, so fleet-wide "all releases of chart X" is a _name_ match until it is known, and the UI says so rather than implying the releases are the same chart.

`appVersion` is the **application's** version, from `app.kubernetes.io/version` — not the chart's, even where the two are byte-identical. Plenty of charts stamp their own version into that label, so equality is not evidence the two mean the same thing and no code path may derive one from the other.

Modelled as its own relation rather than a `deployment_sources` table with a `kind` discriminator: ArgoCD commonly deploys _via_ Helm, so a workload legitimately has both at different layers and a discriminator would force a choice between two true answers. That sibling table is `gitops_applications`.

- **References:** `organizations.id`, `clusters.id`
- **Referenced by:** `workloads`

### `gitops_applications`

A GitOps application — the **delivery** layer, keyed `(clusterId, namespace, name)` exactly like a release. Answers "what delivers this, and where do I change it", where `helm_releases` answers "what chart packaged this, at what version".

Two tables rather than one discriminator, and the reference cluster is the argument: fourteen of its twenty-three attributed workloads have _different, both-correct_ answers to those two questions. The chart version is what a CVE report cites; for an Argo user the fix is a `targetRevision` bump, and only this row says where to make it. A single `source` column would have made each of them pick one and discard the other, and the discarded half is the half the remediation flow needs.

- `namespace` is the **application object's** own namespace — `argocd`, or a team namespace under apps-in-any-namespace — never its destination. That is `destinationNamespace`, and the two differ for essentially every app.
- `repoUrl`, `targetRevision`, `chart` and `path` are all nullable: the tracking annotation on a workload names the app and nothing else, so they are filled in only when the agent could read the `Application` object itself.
- `chart` and `path` are mutually exclusive in ArgoCD's own model — a chart source names a chart in a Helm repository, a directory source names a path in git.

- **References:** `organizations.id`, `clusters.id`
- **Referenced by:** `workloads`

---

## Images & SBOMs

### `images`

A container image **as seen by one cluster**. Identity is `(cluster_id, digest)`, enforced by `images_cluster_digest_unique` — [ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md), which reversed ADR 0004's "no tenant column" invariant. An uploaded SBOM is an unverified claim about the bytes a digest names, and sharing that claim across tenants let any tenant's upload dictate every other tenant's findings for a digest; scoping the row to the uploading cluster makes SBOM poisoning and the scanned-digest oracle impossible rather than detected. The cost, accepted: the same digest in staging and prod clusters is two rows, two pulls, two syft runs, two matching passes.

`org_id` is denormalised from the cluster, exactly as on `namespaces`, with the composite FK `(cluster_id, org_id) → clusters (id, org_id)` keeping the copies from disagreeing. It backs the org read paths and the tenancy checks in `db/tenancy.ts`, which are plain column comparisons now. Both FKs are `NO ACTION`: deletion stays explicit in `cluster.repository.delete` / `delete-helpers.ts`, because `workload_containers.image_id` is `RESTRICT` and a cascade from `clusters` racing the namespace-side cascade into that restrict is an order-dependent failure.

`registry` and `repository` are descriptive only and never take part in identity: the same digest mirrored to two registries is one image (within its cluster).

`last_seen_at` is stamped by every inventory report that mentions the digest and by every SBOM upload for it. Cluster deletion removes the cluster's images explicitly (`deleteImagesForCluster`), so the GC (`deleteOrphanedImages` in `repositories/delete-helpers.ts`, run nightly by the worker) is for images whose cluster still exists but whose digest nothing mentions any more. It collects an image only when **both** hold — no `workload_containers` row references it, and `last_seen_at` is older than the owning org's **plan history window** (`historyDays` in `config/plans.ts`, floored by `IMAGE_GC_RETENTION_DAYS` — the SBOM archive is part of what a paid plan buys). Reachability alone would be wrong twice over: inventory is a full set replacement, so a digest drops to zero containers for the seconds a rollout takes, and an upload-before-inventory image has zero containers until its cluster's next report.

`last_scan_error_code` / `_host` / `_at` say why the digest's last scan attempt failed, from the scanner's stderr classification on the inventory report (`docs/contracts/inventory-v3.md`, "Scan failures are display-only classification"). Display-only, never control flow: the inventory path sets them, and **only a successful SBOM upload for the digest clears them** (`imageRepository.clearScanError`) — a restarted scanner reports an empty failure memory, and that absence must not read as recovery. The code is an open set (`registry_auth` | `registry_rate_limited` | `scan_error` today); the coverage card renders an unknown one as a generic failure. Raw syft stderr never reaches these columns — the inventory schema's charset checks are the fence.

The Admin dashboard's **Images** tab (`adminRepository.listAdminImages`) starts `FROM images` and left-joins the rest, across every tenant. Org-scoped image views filter by `images.org_id` (`deployedImages(orgId)`), so an uploaded-but-undeployed image is visible to the org whose cluster uploaded it — it is their upload. The window that tab counts down against is per-org: `imageGcRetentionDays(plan)` in `config/image-gc.ts`, the same floor-of-plan-window rule the GC sweep evaluates in SQL, so the countdown and the cutoff cannot disagree.

- **References:** `organizations.id`, `clusters (id, org_id)`
- **Referenced by:** `sboms`, `workload_containers`, `jobs`, `vulnerability_scan_runs`

### `sboms`

An uploaded Software Bill of Materials document. CycloneDX is the only ingested format — `format` is always `'cyclonedx'`.

**One SBOM per image, enforced by `sboms_image_id_unique`** — which under ADR 0006 means one SBOM per digest **per cluster**. This is the invariant that replaced `isCurrent`: with exactly one row per image, "the SBOM to count findings from" needs no flag, no `DISTINCT ON` and no tie-breaker, and every counting surface reaches it by the same join. A duplicate upload within a cluster is a 409 unless it carries `?replace=true`, the supersede path that atomically swaps the subtree and re-queues a scan.

Note what is **not** here: no `imageTag`, no `imageRef`, no `labels`, no namespace. Every one of those is a fact about a deployment and lives on `workload_containers`; the cluster is `images.cluster_id`. `scanner_version` (from `X-Scanner-Version`) records which agent build produced the document — provenance for the supersede path.

- **References:** `images.id`
- **Referenced by:** `components`, `component_dependencies`

---

## Components & Component Metadata

### `components`

Individual software components (packages/libraries) extracted from an SBOM. Identified primarily by PURL (Package URL). Includes name, version, type, group, publisher, scope (`required`/`optional`/`excluded`), and whether it's a direct dependency.

`type` is the **CycloneDX** component type (`library`, `application`, `operating-system`, `file`…), not the syft package type — that (`apk`, `deb`, `npm`…) lives only in `component_properties`.

**`tier` / `tier_version`** (component tier plan, item 1) say what _kind_ of thing this occurrence is — a default lens for findings, never a verdict. Written at ingest by the pure classifier in `lib/component-tier.ts` from `syft:package:type`, `syft:location:0:path` and `syft:metadata:mainModule`; `tier_version` is the classifier version that wrote the row, so `pnpm backfill:component-tier` can re-classify from stored properties without a rescan (rows below `TIER_VERSION` only). One per-image refinement follows the per-component rules (`lib/main-component.ts`, item 8): where the image's own `ENTRYPOINT` / `CMD` (`images.metadata`, scanner ≥ 0.4.0) names an executable the SBOM knows, `main` is that component alone and the image's other Go main modules are `application`. The tier is per occurrence, not per package: the same npm package is `application` under `/app/node_modules` and `runtime` inside node's bundled npm.

| `tier`        | Meaning                                                                                                                              | UI bucket   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `os`          | Distro package (apk, deb, rpm, alpm, portage, nix)                                                                                   | Base image  |
| `runtime`     | The language runtime's own tooling: node's bundled npm, pip/setuptools/wheel, the JDK, Ruby default gems, syft binary-cataloger hits | Base image  |
| `application` | A dependency the build added and the customer can bump                                                                               | Application |
| `main`        | The application itself (the Go main module today)                                                                                    | Application |
| `unknown`     | Not classified yet (`tier_version = 0`), or no syft package type (file entries, the distro component)                                | All only    |

"tier", "os" and "runtime" are internal words; the UI says "Application", "Base image", "All".

**`layer_index`** (item 5) is the earliest layer the component exists in, as an index into the image's layers that exist (`image_layers.rootfs_index`): the **minimum** over all its `syft:location:N:layerID` properties, never location 0 alone — location 0 of a deb package is dpkg's status file, which belongs to the last layer that ran apt. Null when the scanner sent no layer list and the registry backfill has not filled one. For `os`-tier rows it is only trustworthy from a deep-squashed SBOM (`layerAttributionTrusted(sboms.scanner_version)` in `lib/image-layers.ts`): under syft's default scope an apk or rpm package has a single location, the package database.

- **References:** `sboms.id`
- **Referenced by:** `component_dependencies`, `component_hashes`, `component_external_refs`, `component_licenses`, `component_properties`, `component_vulnerabilities`

### `known_layer_prefixes`

Public images whose **whole** layer chain we know, keyed by the hash of that chain (`chainHash` in `lib/base-image.ts`). PK `(diff_id_prefix_hash, image_ref)`; `depth` is the chain's length; `source` is `chart-index` (`POST /internal/known-images`), `registry` (the nightly pass fetched a base an image _names_) or `verified-guess` (a tag an image's `_VERSION` env suggested and the registry confirmed as a strict prefix). "The first _k_ layers of this image are a known image" is then one indexed lookup per _k_.

**Global, public, and never written from an upload** (ADR 0006): a customer's own golden bases are found by comparing that org's images with each other at read time, so nothing about one tenant's cluster can be read out of this table by another.

**`images.base_image_ref` / `base_layer_count` / `base_detected_by`** hold the boundary `lib/base-image.ts` resolved — signals in order: `annotation` (the image names its base; counted once a chain of that name is known), `known-image`, `org-prefix` (≥ 2 shared layers inside the org; named when a sibling _is_ the prefix), `buildpacks`, `history` (a stage-ending `CMD`/`ENTRYPOINT` that agrees with the largest jump in layer build time; unnamed). Either of the first two columns can be null alone. Written by `services/base-image.service.ts` after an upload, after the layer backfill, and nightly for images still undecided.

**`components.from_base`** is `layer_index < base_layer_count`: null until the boundary is known, and null for an `os`-tier row whose SBOM is not deep-squashed (`layerAttributionTrusted`). When set it **decides the lens bucket** (`lensBucket` in `db/finding-tier.ts`): an `apt-get install` in the customer's own layer is `os` _and_ theirs. When null, the tier stands in.

### `base_image_checks`

What a **public** base image could be rebuilt on — one row per base ref (`registry`, `repository`, `tag`) some image is built on. `current_digest` is what the tag points to today (a pinned-looking tag like `node:20-bookworm-slim` is rebuilt under the same name for months); `newer_tag` / `newer_digest` is the newest tag `lib/image-tags.ts` calls comparable — same variant, same number of version components, the same major where one exists. `availability` and `skipped` carry the tag-axis verdict in the image-upgrade vocabulary. Written nightly by `refreshBaseChecks` (`services/base-upgrade.service.ts`), which also queues both digests for the platform scanner; the recommendation itself ("removes N of M base-image findings") is computed at read time and never stored. Global and tenant-free, like `known_layer_prefixes`.

### `component_tier_rules`

An org's override of the built-in component classifier: `match_kind` (`purl-prefix` | `name` | `path-prefix`), a literal `pattern` (no wildcards), and the `tier` matching components get. Unique per `(org_id, match_kind, pattern)`, at most 100 per org. Applied **after** the built-in rules — at ingest (`sbom.service.ts`) and by every reclassification (`lib/component-tier-backfill.ts`) — the most specific match winning. A change queues a `tier_reclassify` job for that org only (deduplicated against a still-_pending_ one; a running job has already read the old rules) and writes a `tier-rule.created` / `tier-rule.removed` activity event. It moves components between the lens's buckets; it is **not** suppression.

`organizations.default_finding_tier` (`application` | `all`) is the view the org's findings tables — and the weekly digest's "Start here" — open on when neither a link's `?tier=` nor the reader's own last choice says otherwise.

### `image_control_rules`

An org's own answer to "do you build this image?" — one row per repository (or `prefix/*`), optionally scoped to a registry (stored normalised; null = any). Unique on `(org_id, coalesce(registry, ''), repository)`. Always beats the derived signals; "reset to detected" is a delete. Every set, change and reset is an `image.control-set` activity event (not a Feed type).

**`images.control`** (`built` | `third-party` | `unknown`), **`control_detected_by`** and **`control_detail`** are the verdict in force for each image row, derived from the _repository_ by the pure resolver in `lib/image-control.ts` and written by `services/image-control.service.ts` — after an inventory report (undecided images of the cluster only), after an SBOM upload, after the nightly chart-attribution pass, after a rule change, and by `pnpm backfill:image-control`. Signals, first to fire wins: `rule` → `chart` (the repository is in the rendered image set — `chart_image_observations` — of a public chart that delivers it here; an attributed chart that was never rendered is silent) → `official-image` (`images.metadata.official`) → `private-registry` → `known-image` / `built-on-known` (layer comparison, item 6) → `public-registry` (vendor namespaces). A label, never a score. Internal words: the UI says "Yours" and "Third-party".

- **References:** `organizations.id` (cascade)

### `image_layers`

One row per image-**history** entry, in order — the layers of a digest and the (scanner-redacted, 200-character) Dockerfile line that made each. PK `(image_id, index)`; index on `diff_id` for the known-prefix lookup. Keyed by image, not SBOM, because layers are a property of the digest (ADR 0004): a `?replace=true` re-upload that carries no layers leaves them alone.

`index` counts every history entry, including the ones that made no layer (`ENV`, `CMD`, `LABEL`) — the base-boundary heuristics read those — so `diff_id`, `size` and `rootfs_index` are null on them. `rootfs_index` is the position among the layers that exist; it is what `components.layer_index` refers to and what "9 of 14 layers" counts. `source` is `scanner` (the upload carried `stackradar:layer:*` properties — scanner ≥ 0.4.0) or `registry` (`services/image-layer-backfill` fetched the config blob of a public image scanned before that; nightly, bounded, ends on a 429, and stamps `images.layers_checked_at` so an unreachable image is asked about monthly).

`images.metadata` (jsonb) holds the `stackradar:image:*` facts of the same upload, prefix stripped: `baseName`, `baseDigest`, `source`, `version`, `official`, `entrypoint` / `cmd` (`argv[0]` only), `user`, `architecture`, `env:NODE_VERSION`… The scanner's README is the list of what it may contain.

- **References:** `images.id` (cascade)

### `component_dependencies`

Stores the dependency tree between components within a single SBOM. A parent-child relationship where the parent "depends on" the child. Composite PK on `(sbomId, parentComponentId, childComponentId)`.

- **References:** `sboms.id`, `components.id` (twice — parent and child)

### `component_hashes`

Cryptographic hashes (SHA-256, SHA-512, etc.) for integrity verification of components. A component can have multiple hashes but only one per algorithm.

- **References:** `components.id`

### `component_external_refs`

External references for components, following the CycloneDX spec — links to VCS repos, issue trackers, documentation, security advisories, etc.

- **References:** `components.id`

### `component_licenses`

Many-to-many join table linking **components** to **licenses**. Composite PK on `(componentId, licenseId)`.

- **References:** `components.id`, `licenses.id`

### `licenses`

License definitions with optional SPDX identifiers, name, or expression. Shared across components to avoid duplication.

- **Referenced by:** `component_licenses`

### `component_properties`

Arbitrary key-value properties attached to a component (from the CycloneDX `properties` array). Stores name/value pairs.

- **References:** `components.id`

---

## Remediation Workflow

Findings key on images; the fixes surface (`GET /api/remediation/fixes`)
is computed from them at read time and stores nothing. Two tables from the
earlier issue-tracking design remain in `db/schema/remediation.ts` for their
deprecation window; the third, `activity_events`, is live.

### `issues` (retired)

**No code writes or reads this table since the issue lifecycle was removed;
retained for a two-release deprecation, drop in a later migration.** It held
a tracked commitment and its lifecycle (`open → snoozed → applied →
verified`, plus `closed`), scoped to an image, a release or a finding
identity, with the naming facts denormalised as text so a row outlived the
image GC. Rows that exist in a populated database are history and are left
alone; migration 0024 still re-keys their `vuln_identity` because it runs on
such a database.

- **References:** `organizations.id`, `clusters (id, org_id)`, `images.id` (SET NULL), `helm_releases.id` (SET NULL)

### `finding_states` (retired)

**No code writes or reads this table since the issue lifecycle was removed;
retained for a two-release deprecation, drop in a later migration.** It held
suppress / accept-risk rows keyed on the cross-image finding identity
`(package_type, package_name, vuln_identity)` per org, each with an owner,
a reason and an expiry. No counting surface excludes suppressed findings
any more — nothing can create a suppression, so an exclusion would be dead
code wearing a feature's name.

- **References:** `organizations.id`

### `activity_events`

Append-only change log behind the **Feed** page
(`GET /api/feed`, `activity-feed.repository.ts` — newest first on
`(org_id, created_at)`, keyset-paginated, day-blocked in the view) and the
alert worker's outbound delivery (`services/alert.service.ts`). Carries
**changes, never inventory**: `scan.criticals-increased` (written by
`job.service.ts` when a scan finds more criticals on an image than its
previous scan), and the
`container.*` events the inventory diff produces (`appeared`, `removed`,
`image-changed`, `rollout-started`, `retagged`; a move carries the finding
delta between the two digests when both are scanned) and
`scan.findings-changed` (one event per image per scan with the added and
removed finding keys in the payload, `cause: "mirror"` when the advisory
database moved under a running digest, `"upload"` when the findings came
with a new SBOM). One event per change, never one per finding. Subject FKs
are `SET NULL` so the log outlives what it points at. The `issue.*` and
`finding.suppressed` / `finding.unsuppressed` types stay in the enum for the
rows already written; nothing writes them any more.

- **References:** `organizations.id`, `clusters.id`, `images.id` (SET NULL), `issues.id` (SET NULL)

### `chart_repositories`

Org-scoped Helm chart repositories feeding the remediation suggestions'
**unmeasured** band. A repository is an `index.yaml` URL plus optional HTTP
basic credentials (held server-side — the simplest answer, taken knowingly;
revisit before production). `source` records how
the row came to exist: `observed` (auto-registered by the daily sync from
`helm_releases.repo_url`, never resurrecting a deleted or disabled row),
`manual`, `artifact-hub-confirmed` (a discovery result the user explicitly
accepted), or `artifact-hub-matched` (auto-added by the nightly attribution
pass on version-list identity evidence — see _Artifact Hub Mirror_ below).
A name-only API match is a guess and is never stored silently;
`artifact-hub-matched` rows exist only where the installed chart version
appears in exactly one candidate's version list, and they feed the
**unmeasured band only**.
Fetch bookkeeping (`etag`, `last_fetched_at`, `last_fetch_error`) makes the
daily refresh a conditional GET and surfaces failures in settings. Lives in
`db/schema/chart-repositories.ts`.

- **References:** `organizations.id`

### `chart_repo_entries`

The cached _slice_ of a repository's `index.yaml`: one row per chart the org
actually runs, with its version list (capped) as jsonb. Trimmed at write time
so the suggestion read path never touches charts nothing deploys; replaced
wholesale per fetch with a stamp-and-prune, like the inventory write. An
index can honestly supply _versions that exist_ — everything read from here
stays in the unmeasured band and claims nothing about vulnerabilities.

- **References:** `chart_repositories.id` (CASCADE)

### `artifact_hub_packages`

**Global** (no `org_id`) mirror of Artifact Hub's `/api/v1/nova` bulk dump —
every Helm package the hub indexes, with repository flags
(`repo_verified`, `repo_official`, `official`), `stars`, and the full version
list as jsonb (`{pkg, app, kube, deprecated}`). Natural key
`(repo_name, name)`; `name` alone is deliberately _not_ unique — ~2k chart
names are claimed by more than one repository, which is why attribution
scores evidence instead of looking names up. Refreshed nightly by
[`artifacthub-sync/`](../../src/artifacthub-sync/README.md) with a
stamp-and-prune on `last_seen_at`.

- **Referenced by:** `chart_attributions`

### `chart_attributions`

The inferred repository for an installed chart whose
`helm_releases.repo_url` the scanner could not observe. One row per
`(org_id, chart_name)`; carries the winning `package_id`, the denormalised
`repo_url`, and the matcher's `evidence` jsonb. **Inferred data never lands
in observed columns** — `helm_releases.repo_url` stays ArgoCD-observed-only,
and read paths resolve through this table, labelling the result as an
inference. Written only by the nightly attribution pass, which requires
version-list identity evidence and refuses ties (`lib/chart-attribution.ts`);
stamp-and-pruned on `matched_at`. The `package_id` CASCADE means the mirror
prune deletes attributions mid-cron — safe only because the attribution pass
runs immediately after in the same cron.

- **References:** `organizations.id` (CASCADE), `artifact_hub_packages.id` (CASCADE)

### `artifact_hub_sync_state`

One row, `id = 1`, the `epss_sync_state` shape: `lastSyncedAt`,
`packagesInDump` / `packagesApplied` (mirror counters),
`chartsExamined` / `attributionsWritten` / `attributionsRefused` /
`reposAutoAdded` (attribution-pass counters), `lastError`. Failure never
touches `lastSyncedAt` — the retry must not be blocked by the freshness
guard, and reported freshness has to keep ageing.

### `chart_renders`

One row per attempted render of a candidate chart version.
**Provenance-free**: identity is `(repo_url, chart_name,
chart_version)` and no tenant column exists; the selection _input_ is tenant
data, the row is a public fact. `status` is `rendered` or `render_failed`
(with `failure_reason` — a cap hit, a fetch error, a helm error); a version
with a row is never selected again, so deterministic failures do not retry
nightly. Records the pinned `helm_version` and the `--kube-version` used.

### `chart_image_observations`

`repo_url × chart_name × chart_version × image ref → digest`: one row per
image reference a rendered chart version's PodSpecs deploy, with the ref
normalised (docker.io shorthand expanded) and the manifest-list digest the
registry reported — or a null digest with `resolution_error` when the
registry is off the public allowlist or refused. **Unresolved rows measure
nothing.** Tenant reads cross into this table only through the candidate path
in `recommendForRelease` (release → known public repo → observation →
platform image); there is no general lookup surface.

---

## Vulnerability Data (Application-Level)

### `vulnerabilities`

Core vulnerability records from any source (OSV, NVD, GitHub, Snyk). Uses an OSV-aligned schema with fields for summary, details, severity (CVSS vectors + derived score/level), aliases, references, credits, and the raw source data.

**This is where the OSV mirror lands.** There is no separate `osv_vulns` table — see the note under _OSV Mirror_ below.

Exploitation signal, maintained by two daily syncs and deliberately absent from every column list in `vulnerability.repository.ts`, so an OSV refresh restates the advisory without blanking the intelligence attached to it:

- `epssScore` / `epssPercentile` / `epssUpdatedAt` — FIRST.org's predicted probability of exploitation and its rank. Written by [`epss-sync/`](../../src/epss-sync/README.md), matched by CVE id **or CVE alias**. Null means EPSS does not cover this advisory, which is correct and must never be defaulted to zero.
- `kevListedAt` / `kevDueDate` / `kevRansomware` — CISA's Known Exploited Vulnerabilities catalogue. Written by [`kev-sync/`](../../src/kev-sync/README.md), which is a **full replacement**: a delisted CVE has these cleared, because a stale listing pins the risk score at maximum forever.
- `riskScore` — `GENERATED ALWAYS AS (…) STORED`, 0–100, over the four columns above plus `cvssScore` and `severityLevel`. Never written by a caller; Postgres re-derives it on any `UPDATE` to the row, which is what makes the daily EPSS sync the recomputation. Formula and reasoning: [ADR 0005](../../../docs/adr/0005-risk-is-two-layers.md), implementation `db/risk-model.ts`.

- `findingIdentity` — the cross-image collapse key ("which advisories are the same vulnerability"): the record's own CVE id, the single CVE it names among its `aliases` **or `upstream`** (a distro tracker entry such as `UBUNTU-CVE-2026-4046` names its CVE only under `upstream`), with no CVE at all `#<GHSA>` when the record, its `aliases` and `upstream` hold exactly one GitHub advisory (so `GO-2026-6061` and `GHSA-hrxh-6v49-42gf` share `#GHSA-hrxh-6v49-42gf`), or otherwise `#<vuln_id>`, standing alone. A pure function of `(vuln_id, aliases, raw_data->'upstream')` (`lib/vulnerability-aliases.ts#findingIdentityOf`), computed at ingest by the OSV sync — the only writer of these rows — so a mirror rewrite is the recomputation. `db/findings.ts#findingIdentity` reads it; the drift-guard test `tests/integration/findings/finding-identity.test.ts` keeps the stored value, the TypeScript rule and the original SQL derivation in agreement. Indexed (`vulnerabilities_finding_identity_idx`) for the identity drill-downs.
- `severitySource` — null when `severityLevel` / `cvssScore` are the record's own; otherwise the `vuln_id` of the record of the same `findingIdentity` they were lent by, because this record publishes no severity (the Go vuln DB never states CVSS). Written only by `osv-sync/severity-fill.ts`, nulled by every OSV upsert; `risk_score` follows the lent values. Partial-indexed (`vulnerabilities_severity_source_idx`) for the fill's "who borrowed from these" lookup.

The advisory columns above are exposed to the chart index (`charts/`) through `POST /internal/match` (`services/match.service.ts`) — a stateless call that runs the matcher over these tables and returns the collapsed findings with each row's `riskScore`; see `docs/contracts/match-endpoint.md`. No table is written by it.

Rolling these up for an image, workload or release is `db/risk.ts`, at read time. It is _not_ composable — the fold decays each finding by its rank within one group — so a workload's score is folded from raw findings and never from its images' scores.

- **Referenced by:** `vulnerability_affected_packages`, `component_vulnerabilities`

### `vulnerability_affected_packages`

Which package versions a vulnerability affects — maps to the OSV `affected[]` array. Stores ecosystem, package name, PURL, version ranges, explicit affected versions, and a derived `fixedVersion`.

The matcher's lookup columns, all computed at ingest by `src/matching/`:

- `matchKey` — the canonical identity from `matching/identity.ts`, computed the same way here and on the component PURL at match time. This is the hot lookup key. Changing a key rule requires re-ingesting the mirror.
- `ecosystemFamily` / `ecosystemRelease` — the OSV ecosystem string split at its first colon, so distro release scoping is a SQL filter instead of a post-filter.
- `withdrawn` — denormalized from `vulnerabilities.withdrawnAt` so the lookup needs no join. Both sync paths derive it from the OSV record at extract time. The `matchKey` index is partial on `withdrawn = false`.

- **References:** `vulnerabilities.id`

### `component_vulnerabilities`

Many-to-many join table linking **components** to **vulnerabilities** after matching is performed. Records how the match was made (`matchedBy`: `purl`, `cpe`, `name_version`), whether the component matched on its own identity or via its source package (`matchType`: `direct`, `indirect`), and the confidence level (`matchConfidence`: `exact`, `fuzzy`, `unconfirmed`). Composite PK on `(componentId, vulnerabilityId)`.

Provenance columns record _which_ `affected[]` entry won the match, which is not a question a read-time join on package name can ask:

- `fixedVersion` — the fix stated by the winning entry, or null when the advisory states none.
- `upstreamName` / `upstreamVersion` — the source package that carried an `indirect` match, and the version the range check actually used (source versions, not the binary's). Null on a `direct` match.
- `matchedEcosystem` — full OSV ecosystem string of the winning entry (`Alpine:v3.23`). Diagnostic; first thing to check when release scoping is suspected of leaking.

All of these are refreshed on re-scan by `bulkLinkComponentVulnerabilities`, not frozen at first insert.

- **References:** `components.id`, `vulnerabilities.id`

### `vulnerability_sync_status`

Tracks the sync state per vulnerability source (e.g. "osv", "nvd"). Stores last sync time, status, cursor for incremental syncs, and error messages.

---

## Exploitation Feeds

Both are single-row state tables on a constant PK, defined in `db/schema/threat-intel.ts`. They are separate from `osv-mirror.ts` because they are a different kind of sync: the OSV mirror _owns_ rows and a failed bootstrap leaves the matcher with nothing to match against, hence its generations and per-record failure log. These two only `UPDATE` columns on advisories the mirror already wrote, so a failed run leaves yesterday's data in place and the machinery is correspondingly smaller.

Neither records `lastSyncedAt` on failure — the freshness the API reports has to keep ageing, and the retry must not be blocked by the 23-hour guard.

### `epss_sync_state`

`lastSyncedAt`, `lastScoreDate`, `rowsInFile`, `rowsMatched`, `rowsUnmatched`, `lastError`, `runStartedAt`.

`lastScoreDate` is the feed's own `score_date`, as distinct from when we fetched it — a sync succeeding nightly against a frozen feed is a healthy-looking pipeline serving stale predictions, and this is the only column that shows it. A large `rowsUnmatched` is expected: EPSS scores every CVE in the NVD, the mirror holds only those with an ecosystem or distro advisory.

### `kev_sync_state`

`lastSyncedAt`, `catalogVersion`, `releasedAt`, `entriesInCatalog`, `entriesMatched`, `entriesCleared`, `lastError`, `runStartedAt`.

`runStartedAt` on both: set when a run passes the freshness guard, cleared when it records success or failure. It is how the app shell's banner on a fresh install says a feed is _scoring now_ rather than _not yet_ (`lib/mirror-status.ts`); a stamp a dead process left behind is disbelieved after `FEED_RUN_STALE_AFTER_HOURS` (`lib/feed-health.ts`).

`entriesCleared` is the one to watch. KEV sync is a full replacement, so this counts advisories CISA has delisted since the last run — normally zero or a handful. A large value means the join broke, not that CISA had second thoughts.

---

## OSV Mirror (Local Vulnerability Database)

### `osv_sync_state`

A single-row table (PK always `1`) tracking the overall sync state of the local OSV vulnerability mirror. Records whether initialization is complete, last poll time, watermark timestamps, current sync status, and failure counters — plus `bootstrapProgress`, a jsonb snapshot of where a running bootstrap is (the archive plan with each finished archive's record count, the current archive's phase, bytes and records), non-null only during one, for the fresh-install banner.

> **There is no `osv_vulns` table, and no `osv_affected_packages`.** Earlier
> revisions of this document described both, and downstream documents
> inherited the mistake. `osv-mirror.ts` defines
> only the three bookkeeping tables in this section; the mirror's _content_ goes
> into `vulnerabilities` and `vulnerability_affected_packages` above. Anything
> planning to write to `osv_vulns` is planning against a table that does not
> exist.

### `osv_sync_runs`

One row per completed sync cycle, initialization or incremental. A queryable history of sync activity without parsing logs.

### `osv_sync_failures`

Logs individual parse or download failures during OSV sync runs. Each failure records the sync run ID, mode, the OSV ID (if parseable), source path, and the error details.

---

## Background Jobs

### `jobs`

Tracks background processing tasks: SBOM processing, vulnerability scanning, full syncs, and scheduled scans — plus the platform jobs `chart_render` and `platform_scan`, which run under the system org and are never creatable through the API. Each job belongs to an organization and optionally to an **image** — a scan job is about an image, not a workload, so the same digest in five namespaces is one job rather than five. Includes status, priority, progress tracking, scheduling, retry handling, and input/output data as JSON.

- **References:** `organizations.id`, `images.id`

### `vulnerability_scan_runs`

Durable, per-image history of each time an image's SBOM was scanned against the local OSV mirror. Deliberately separate from `jobs`, which is the worker queue and is pruned; this is domain history that outlives it.

- **References:** `organizations.id`, `images.id`, `sboms.id` (`SET NULL`), `jobs.id` (`SET NULL`)

---

## Relationship Diagram

```
users ──┬── org_members ──── organizations ──── clusters ──┬── namespaces ──── workloads ──── workload_containers
        ├── org_invites ──────────┘                        │                       │                    │
        └── api_keys ─────────────┘                        ├── helm_releases ───────┘                    │
                                                           │        (releaseId, nullable)                │
                                                           └── workload_container_history ── (the past of workload_containers; workload_id / image_id SET NULL)
                                                                                                         │ imageId
                                                                                                         ▼
                                          jobs ─────────────────────────────────────────────────────► images
                                          vulnerability_scan_runs ──────────────────────────────────►   │
                                                                                                         │
                                                                                       sboms ◄───────────┘
                                                                                         │  (exactly one per image)
                                                                                    components
                                                                                         │
                                             ├── component_dependencies ────────────────┤
                                             ├── component_hashes ────────────────────── ┤
                                             ├── component_external_refs ─────────────── ┤
                                             ├── component_licenses ── licenses ───────  ┤
                                             ├── component_properties ────────────────── ┤
                                             └── component_vulnerabilities ── vulnerabilities
                                                                                    │
                                                                 vulnerability_affected_packages

osv_sync_state / osv_sync_runs / osv_sync_failures  (standalone bookkeeping)
epss_sync_state / kev_sync_state                    (standalone bookkeeping)
vulnerability_sync_status                           (standalone)
```

The shape to notice: **`images` hangs off `clusters` now** (`cluster_id` +
denormalised `org_id`, ADR 0006), so every path from
`component_vulnerabilities` up to a tenant runs through `images.cluster_id` —
that is the provable isolation property. Every deployment fact still hangs off
the left-hand chain; everything derived from an uploaded SBOM hangs off
`images`, inside one cluster.

The `osv_*`, `epss_*` and `kev_*` tables are **bookkeeping only** — sync state,
run history, failures. They hold no advisory data. Everything the matcher reads
lives in `vulnerabilities` and `vulnerability_affected_packages`, and everything
the three feeds write lands on those same rows: the OSV sync writes the advisory,
the EPSS and KEV syncs decorate it, and `vulnerabilities.risk_score` regenerates
itself from whichever of them last committed.

That single destination is why there is no propagation step and no recompute job.
It is also the correction to the four documents that assumed otherwise; see the
note in the OSV Mirror section.

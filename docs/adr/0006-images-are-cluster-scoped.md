# Images are cluster-scoped

**Status:** accepted, implemented.
**Supersedes:** the first invariant of
[ADR 0004](0004-image-as-the-unit-of-identity.md) ("`images` has no `orgId` and
no `clusterId`"). ADR 0004 is otherwise unchanged and still describes the
model; only its sharing invariant is reversed here.

`images` — and therefore SBOMs, components and findings — are scoped to a
single **cluster**. Identity is `(cluster_id, digest)`. No sharing of image
rows, SBOMs, or match results across clusters, not even within one org. Every
SBOM upload and every `GET /v1/sboms/check` requires a cluster-scoped API key,
and each answers for that cluster alone.

## The threat model

The ADR 0004 model trusted uploaded SBOMs and shared them globally by digest:

- `createFromCycloneDx` rejected any second upload for an image
  (`DuplicateSbomError`, enforced by `sboms_image_id_unique`). **First writer
  wins, permanently** — there was no supersede path.
- `GET /v1/sboms/check` answered `existsByDigest` **globally**, so every other
  tenant's scanner skipped the digest entirely and never produced its own SBOM.
- Findings derived from that one SBOM's components; tenancy entered only at
  read time. One tenant's uploaded document therefore dictated every tenant's
  vulnerability report for that digest.

Nothing verifies that an uploaded SBOM actually describes the digest it names —
the digest is a string in the query. A malicious or compromised tenant could
upload an empty or stripped SBOM against a popular public digest and **suppress
findings for every other tenant running it**, permanently. A merely bad scan
(old syft, truncated document) poisoned everyone the same way. The global
`check` was also a small oracle: "has anyone on this platform scanned digest
X?"

## Decision

The isolation boundary is the **cluster**: every cluster pulls, scans and
uploads its own SBOM for every digest it runs. An SBOM can only ever influence
findings inside the cluster whose key uploaded it.

Concretely:

- `images` gains `org_id` and `cluster_id`, both `NOT NULL` — the same
  denormalised pair as `namespaces`, with the same composite FK to
  `clusters (id, org_id)` so the copies cannot disagree. The unique index is
  `(cluster_id, digest)`, replacing `images_digest_unique`.
- One SBOM per image is kept (`sboms_image_id_unique` unchanged); it now means
  one SBOM per digest **per cluster**.
- `POST /v1/sboms/upload/cyclonedx` requires a cluster-scoped key for every
  upload (403 otherwise), not only for the workload link.
- `GET /v1/sboms/check` requires a cluster-scoped key and answers "has **this
  cluster** scanned this digest". The scanner needs no protocol change — it
  asks the same question and now gets a scoped answer.
- Tenancy becomes a column: `db/tenancy.ts`'s "an org may see an image it is
  running" (an EXISTS probe over `workload_containers`) is now
  `images.org_id = $org`. Deliberate semantic change: an
  uploaded-but-not-yet-inventoried image is **visible to its owning org**
  (previously invisible until a container referenced it). That is correct — it
  is their upload.

## Alternatives considered

**Provenance + supersede, sharing kept.** Record who uploaded each SBOM, let
later uploads supersede earlier ones, keep cross-tenant reuse. Rejected: it
turns poisoning from *impossible* into *detectable*, and the detector is a
customer noticing their findings changed. It also keeps the oracle, and
"whose SBOM wins" becomes a trust-ranking problem with no principled answer
among untrusted tenants.

**Org-scoped images.** Closes the cross-tenant poisoning hole at lower
duplication cost (staging and prod share a row). Rejected because the
credential that uploads is a *cluster* key: a leaked staging key could still
poison prod's findings inside the same org, and cluster deletion would still
strand shared rows. The cluster is the boundary the credential already draws.

**Verify uploads against the registry.** Pull the digest platform-side and
check the SBOM matches. That is a platform-operated scanner — the compatible
future shape for sharing (see below) — but it abandons the agent-side scanning
architecture rather than fixing its trust model, and it does not exist today.

## Consequences accepted up front

1. **Cluster-free ingest is retired.** An SBOM upload with no cluster behind it
   (CI pipeline, registry scan, manual upload before any agent is installed)
   has nowhere to hang once image identity is `(cluster_id, digest)`. Every
   upload now requires a cluster-scoped API key.
2. **Two backlog proposals become unbuildable as written**:
   [`zero-install-onboarding.md`](../proposals/zero-install-onboarding.md)
   (premise: upload before a cluster exists) and
   [`public-image-intel.md`](../proposals/public-image-intel.md) (premise: a
   shared, tenant-free SBOM for a public digest). If either is wanted later,
   the compatible shape is a **platform-operated scanner** publishing canonical
   SBOMs under a StackRadar-owned system org/cluster — sharing that requires
   trusting no tenant.
3. **Intra-org dedup is gone.** The same digest in staging and prod clusters is
   two `images` rows, two pulls, two syft runs, two SBOMs, two matching passes,
   two sets of `component_vulnerabilities`. This is the accepted cost of
   containing a compromised cluster-scoped key to its own cluster.
4. **"Image" now means "image as seen by one cluster".** Org-level surfaces
   show per-cluster rows (the images view carries the cluster name);
   re-aggregating by digest at read time is a possible later lens. Org-level
   upgrade recommendations deliberately read across clusters within the org —
   reads within an org were never the threat.
5. **Plan limits shift meaning.** `uniqueImagesPerMonth` now counts per
   cluster-image: one digest deployed to 3 clusters consumes 3 uploads.
   Accepted; revisit plan sizing separately if it bites.

## What it buys

- SBOM poisoning and the digest oracle stop being **possible** rather than
  detected.
- A leaked cluster key can only corrupt that cluster's data.
- Cluster deletion is a clean cascade: the cluster owns its images outright,
  so nothing of a tenant's data outlives the cluster
  (`cluster.repository.delete` + `deleteImagesForCluster`).
- A **supersede/re-scan path** is safe: `POST
  /v1/sboms/upload/cyclonedx?replace=true` (own cluster only) atomically
  replaces the image's SBOM and queues a fresh scan — the recovery path for a
  bad scanner version, a truncated upload, or a revoked key. `sboms` records
  `scanner_version` (`X-Scanner-Version`) as provenance; `images.cluster_id`
  attributes the upload to a cluster.

# The image is the unit of identity, not the project

> **Status note (ADR 0006).** The "no `orgId`, no `clusterId`" invariant below
> — and everything derived from it: cross-tenant SBOM reuse, the global
> `/v1/sboms/check`, cluster-free ingest — is reversed by
> [ADR 0006](0006-images-are-cluster-scoped.md). Images are now scoped to one
> cluster, identity `(cluster_id, digest)`. The rest of this ADR (the
> `projects` tree removal, the Kubernetes entities, one SBOM per image) still
> stands.

SBOMs and findings belong to an **image digest**, not to a workload. The generic
`projects` tree (`type: "project" | "group"`, self-referencing `parentId`) is
replaced by explicit Kubernetes entities: `clusters → namespaces → workloads →
workload_containers`, each container referencing an `images` row.

```
organizations
  └── clusters
        └── namespaces  (clusterId, name, labels)          ← the "folder"
              └── workloads  (kind, name)                  ← Deployment/StatefulSet/…
                    └── workload_containers (name, imageId, imageRef, imageTag)
                                                  │
images (digest PK, registry, repository)  ←───────┘   no orgId, no clusterId
  └── sboms → components → component_vulnerabilities
```

`sboms.projectId` becomes `sboms.imageId`. A workload does not have findings; it
*references an image that does*.

## Why

A digest is content-addressed, so its SBOM is the same artefact everywhere it
runs. Keying SBOMs by workload made the same image scanned once per place it
appeared: dedup was `existsByDigestAndProject(clusterId, projectName, groupName,
digest)` and the agent's dedup key was `digest::namespace::containerName`, so one
image in five namespaces meant five pulls, five syft runs, five sets of
components and five matching passes.

It also blocked four queued proposals at once. `base-image-recommendations`
depends on reusing a public digest's SBOM across tenants, which is unsafe while
an SBOM belongs to a customer's project; `public-image-intel` and
`zero-install-onboarding` both need an SBOM with no cluster behind it, which
`projects.clusterId NOT NULL` forbids. `images` carries no tenant, so all three
stop being special cases.

Remediation is the deciding argument: the action a user can take is "change
`image:` from A to B", which is one action per image however many workloads share
it. The model should name the thing the action is about.

## Considered options

**Rename `project` → `workload` and keep the tree.** Fixes the vocabulary — the
UI already routes `/clusters/[id]/workloads` while the API says projects — and
none of the above. The naming mismatch is a symptom.

**Keep the generic tree for non-Kubernetes sources later.** That optionality was
already spent when `clusterId` became `NOT NULL`, and `images` is *more*
source-agnostic than `projects`, not less: an image scanned in CI is an image
with no workload pointing at it.

**Strangler migration with dual writes.** Rejected because StackRadar is not in
production. There is no data to preserve, so the transitional complexity buys
nothing.

## Consequences

- **Namespaces stay browsable.** The "folder" view is preserved as a real entity
  rather than a `type: "group"` row, and it gains a home for the namespace labels
  that risk ranking wants (`environment=prod`).
- **Grouping becomes a lens, not a hierarchy.** The same rows group by namespace
  (the folder), by image (remediation) or by Helm release (`helm_releases`, a
  nullable `workloads.releaseId`). The old tree could express exactly one of the
  three, because it was the storage structure.
- **Findings key on images; actions may not.** Where a Helm release owns the
  image tags, the deliverable change is one `helm upgrade` spanning several
  images, so a remediation action carries a scope. Impact is still measured per
  image — scope decides delivery, not benefit.
- **`discovered_workloads` is deleted.** It existed because pending rows in
  `projects` would have inflated every count that filters `type = 'project'`. With
  running workloads and scanned images in separate tables, "discovered" is
  `workload_containers` and "scanned" is those whose image has an SBOM — one
  `LEFT JOIN`, and `scanned <= discovered` holds without a filter.
- **`sboms.isCurrent` is deleted.** A digest has exactly one SBOM forever, so
  currentness is a property of which digest a workload references, not of the
  SBOM. This dissolves `digest-identity-gaps.md` §1 (rollback leaving a stale
  `is_current` row) rather than fixing it.
- **`imageTag` moves to `workload_containers`.** A tag is what a deployment asked
  for, not a fact about the image — one digest may carry many tags, and a
  digest-pinned deployment has none.
- **Two partial unique indexes disappear**, along with the 409s raised when a
  name collides between a group and a project.
- **Cross-tenant SBOM reuse becomes a tenancy question about `images`**, and it
  is the one place to audit: a digest is a public fact, the fact that a given
  customer runs it is not.
- Every reference to `projects` across server, client and scanner changes at
  once. See `docs/proposals/kubernetes-native-data-model.md` for the cutover,
  which is **done** — the tables below are the shipped schema, not a target.
- **Totals have to be deduplicated by image, everywhere.** This is the
  consequence that showed up in the most places and is the easiest to
  reintroduce: summing findings per row is correct when a row is a project and
  wrong when a row is a container, because containers sharing an image share
  one finding. `db/findings.ts` on the server and `getTotalVulnerabilities` on
  the client are the two implementations, and they must agree.

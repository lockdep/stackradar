# Server

The Express API and background processing for StackRadar: ingesting SBOMs, mirroring the OSV vulnerability database, matching components against vulnerabilities, and serving application data to the BFF.

## Language

### Inventory

**SBOM**:
A Software Bill of Materials document (CycloneDX) describing the components of one scanned workload/container image, uploaded by the **Scanner Agent**. Deduplicated per project by content hash.
_Avoid_: manifest, bill-of-materials, upload

**Component**:
A single software package or library extracted from an SBOM, identified primarily by its **PURL**.
_Avoid_: package, dependency, library (use "Component" for the stored record; "dependency" only for the parent→child relationship)

**PURL**:
Package URL — the canonical string identity for a component (e.g. `pkg:npm/lodash@4.17.21`). The primary key for matching.
_Avoid_: package id, coordinate

**Project**:
A `projects` row of kind `"project"` — a scanned workload/container image (carrying `registry`/`imageRef`/`imageDigest` metadata) that holds SBOMs. Always scoped to a **Cluster** (`clusterId`, not null); auto-created by the **Scanner Agent** on upload.
_Avoid_: repo, app, service, codebase (a Project is a scanned image within a Cluster, not a source repo)

**Group**:
A `projects` row of kind `"group"` — a Cluster-scoped container that nests Projects or other Groups via `parentId` (typically reflecting cluster structure). A Group never holds SBOMs directly.
_Avoid_: folder, team (a Group lives inside one Cluster)

### Vulnerabilities

**OSV Mirror**:
The local copy of the OSV.dev database (`osv_*` tables) — raw vulnerability records and a denormalized affected-package index, kept in sync independently of any customer data.
_Avoid_: vuln cache, OSV cache

**Vulnerability**:
An application-level vulnerability record (`vulnerabilities` table), OSV-aligned, that has been promoted into the app domain and can be matched to Components. Distinct from a raw OSV Mirror record.
_Avoid_: CVE, advisory, OSV record (a CVE is an _alias_; an OSV record is the raw upstream source, not the app-level Vulnerability)

**Match**:
The link between a Component and a Vulnerability (`component_vulnerabilities`), recording the **match method** (`purl` / `cpe` / `name_version`) and **confidence** (`exact` / `partial`).
_Avoid_: hit, finding, detection

**EPSS**:
Exploit Prediction Scoring System score attached to a vulnerability — the probability it will be exploited. Distinct from **CVSS** (severity).
_Avoid_: exploit score (be explicit: EPSS = likelihood, CVSS = severity)

**Watermark**:
A timestamp the OSV sync advances to mark how far the mirror is caught up; incremental polls resume from it.
_Avoid_: cursor, offset, checkpoint

### Processing & Monitoring

**Job**:
A row in the `jobs` table representing background work (SBOM processing, vulnerability scan, full sync, scheduled scan), claimed by the polling **Worker**.
_Avoid_: task, queue item

**Worker**:
The separate process that polls the `jobs` table and runs jobs. Not a hosted queue.
_Avoid_: consumer, runner, queue

**Vulnerability Scan Run**:
A single execution of matching a project's Components against Vulnerabilities (`vulnerability_scan_runs`).
_Avoid_: scan, job (a scan run is the _outcome_; the Job is the unit of scheduled work that produces it)

**Cluster**:
A Kubernetes cluster monitored by the StackRadar **Scanner Agent**, authenticated by its own API key.
_Avoid_: environment, deployment target

**Scanner Agent**:
The in-cluster agent (installed via Helm) that scans **Workloads**, generates **SBOMs**, and uploads them to `/v1/sboms/upload/cyclonedx` using a **cluster-scoped API key**. This is the sole SBOM ingestion path — org-scoped keys are rejected. It also calls `/v1/heartbeat`; its version arrives in the `X-Scanner-Version` header and is stored as `scannerVersion`.
_Avoid_: scanner, probe, collector

**Cluster-scoped API Key**:
An `api_keys` row whose `clusterId` is set, binding it to one **Cluster**. Required for SBOM upload and heartbeat. An org-scoped key (no `clusterId`) cannot upload.
_Avoid_: token, scanner key

**Workload**:
A running Kubernetes unit counted in cluster metrics (`totalWorkloads`). Not a Component.
_Avoid_: pod, deployment, service

## Relationships

- An **Organization** owns **Clusters**, API keys, and **Jobs**
- A **Cluster** is monitored by a **Scanner Agent** and owns the **Projects**/**Groups** discovered in it
- A **Scanner Agent** uploads **SBOMs**, auto-creating Cluster-scoped **Projects**/**Groups** keyed by image/workload metadata
- A **Project** (a scanned image) has many **SBOMs**; one may be `isCurrent`
- An **SBOM** yields many **Components**
- A **Component** is linked to a **Vulnerability** through a **Match**
- A **Vulnerability** is promoted from the **OSV Mirror**, not read from it live
- A **Job** of type "vulnerability scan" produces a **Vulnerability Scan Run**

## Example dialogue

> **Dev:** "Where do **SBOMs** come from — does CI push them?"
> **Domain expert:** "No. The **Scanner Agent** runs in the customer's **Cluster**, scans **Workloads**, and uploads an **SBOM** per image with a **Cluster-scoped API Key**. Upload rejects org-scoped keys. Each upload auto-creates the Cluster-scoped **Project**."

> **Dev:** "When we ingest an **SBOM**, do we write straight into `osv_vulns`?"
> **Domain expert:** "No — `osv_vulns` is the **OSV Mirror**, synced separately. Ingestion creates **Components**, then a scan **Matches** them against application-level **Vulnerabilities**. The mirror is upstream raw data; it never references customer data."

> **Dev:** "Is a critical **EPSS** the same as a critical severity?"
> **Domain expert:** "No. **CVSS** is severity, **EPSS** is exploitation likelihood. A low-severity vuln can have high EPSS."

## Flagged ambiguities

- "vulnerability" was used for both the raw `osv_vulns` mirror record and the app-level `vulnerabilities` record — resolved: **OSV Mirror** record (raw upstream) vs **Vulnerability** (promoted, matchable). They are separate models on purpose; see `docs/adr/`.
- "scan" was used for both the scheduled unit of work and its result — resolved: **Job** (work to do) vs **Vulnerability Scan Run** (result).
- "component" vs "workload" — **Component** is a software package from an SBOM; **Workload** is a running Kubernetes unit in a **Cluster**. Different counts, different sources.
- "SBOM uploads come from CI/CD" — **incorrect** (a stale assumption in earlier docs). SBOMs are uploaded only by the in-cluster **Scanner Agent** using a **Cluster-scoped API Key**; the upload endpoint rejects org-scoped keys. There is no CI/CD upload path.
- "Project" as a source repo — **incorrect**. A **Project** is a scanned workload/image inside a **Cluster**, not a Git repo or codebase.
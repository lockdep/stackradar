// Re-export all schema tables and types

// Auth tables
export * from "./users.js";
// Append-only evidence of which terms version each user accepted, and when.
export * from "./terms-acceptances.js";
// Which ad click, if any, brought a self-signed-up user here; feeds the
// conversion events reported back to the ad network.
export * from "./signup-attributions.js";

// Organization & billing
export * from "./organizations.js";
export * from "./org-members.js";
export * from "./org-invites.js";
export * from "./api-keys.js";
export * from "./clusters.js";

// Kubernetes inventory — clusters → namespaces → workloads → workload_containers,
// with helm_releases (what packaged it) and gitops_applications (what delivers
// it) as two independent grouping axes over the same rows. Two tables rather
// than one discriminator, because ArgoCD commonly deploys *via* Helm and a
// workload legitimately has both. See docs/adr/0004-image-as-the-unit-of-identity.md
// and docs/contracts/inventory-v3.md.
export * from "./namespaces.js";
export * from "./helm-releases.js";
export * from "./gitops-applications.js";
export * from "./workloads.js";
export * from "./workload-containers.js";
// The past of workload_containers, as intervals per slot — the activity feed's
// source for "what moved".
export * from "./workload-container-history.js";

// Business logic tables
export * from "./images.js";
export * from "./image-layers.js";
export * from "./image-control-rules.js";
export * from "./known-layer-prefixes.js";
export * from "./base-image-checks.js";
export * from "./component-tier-rules.js";
export * from "./sboms.js";
export * from "./components.js";
export * from "./component-dependencies.js";
export * from "./component-hashes.js";
export * from "./component-external-refs.js";
export * from "./licenses.js";
export * from "./component-properties.js";
export * from "./vulnerabilities.js";
export * from "./jobs.js";
export * from "./vulnerability-scan-runs.js";
export * from "./osv-mirror.js";
// The remediation workflow — actions, suppression, the activity log.
export * from "./remediation.js";
// Chart repository awareness for the suggestion feed's unmeasured band.
export * from "./chart-repositories.js";
// Artifact Hub mirror + chart attribution.
export * from "./artifact-hub.js";
export * from "./chart-attributions.js";
// Rendered candidate charts and the images they deploy — provenance-free.
export * from "./chart-observations.js";
// Exploitation feeds decorating `vulnerabilities` — see risk-model.ts.
export * from "./threat-intel.js";
export * from "./org-metrics-snapshots.js";
export * from "./cluster-metrics-snapshots.js";
// User-submitted in-app feedback, reviewed on the admin dashboard.
export * from "./feedback.js";
// Append-only log of weekly digest emails, updated by the Resend webhook.
export * from "./digest-sends.js";
// Append-only log of critical/KEV alert messages (email + Slack), same webhook.
export * from "./alert-sends.js";

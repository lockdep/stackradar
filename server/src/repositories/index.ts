export { componentRepository } from "./component.repository.js";
// The Packages page (cluster- or org-scoped) — split from the SBOM component readers.
export { packageRepository } from "./package.repository.js";
export { sbomRepository } from "./sbom.repository.js";
export { vulnerabilityRepository } from "./vulnerability.repository.js";
// The OSV mirror's writers and state — tenant-blind, unlike the readers above.
export { vulnerabilityMirrorRepository } from "./vulnerability-mirror.repository.js";
export { jobRepository } from "./job.repository.js";
export { vulnerabilityScanRunRepository } from "./vulnerability-scan-run.repository.js";

// Kubernetes model — see docs/adr/0004-image-as-the-unit-of-identity.md.
// `project.repository.ts` split into these: `images` carries content
// identity, and the containment chain carries deployment facts.
export { imageRepository } from "./image.repository.js";
export { workloadRepository } from "./workload.repository.js";
export { namespaceRepository } from "./namespace.repository.js";
export { helmReleaseRepository } from "./helm-release.repository.js";
export { inventoryRepository, type InventoryReportInput } from "./inventory.repository.js";

// The remediation workflow: the per-image rollup and the issue lifecycle.
export { remediationRepository } from "./remediation.repository.js";
// The past of workload_containers and the activity feed's reader.
export { containerHistoryRepository } from "./container-history.repository.js";
export { exposureRepository } from "./exposure.repository.js";
export { activityFeedRepository } from "./activity-feed.repository.js";

// Auth & organization repositories
export { organizationRepository } from "./organization.repository.js";
export { inviteRepository } from "./invite.repository.js";
export { userRepository } from "./user.repository.js";
export { clusterRepository, type ClusterWithApiKeyStatus } from "./cluster.repository.js";
export { chartRepositoryRepository } from "./chart-repository.repository.js";
export { chartAttributionRepository } from "./chart-attribution.repository.js";
export { metricsRepository } from "./metrics.repository.js";
export { adminRepository } from "./admin.repository.js";
export { adminStatusRepository } from "./admin-status.repository.js";
export { adminMatcherRepository } from "./admin-matcher.repository.js";
export { adminExplorerRepository } from "./admin-explorer.repository.js";
export { radarScoreRepository } from "./radar-score.repository.js";
export type {
    ClusterRadarScoreImage,
    ClusterRadarScorePage,
    ClusterRadarScoreFinding,
    TopFinding,
} from "./radar-score.repository.js";
export { alertRepository, type AlertOrg } from "./alert.repository.js";
// The global search palette (⌘K).
export { searchRepository, classifySearchTerm } from "./search.repository.js";
export type { SearchResult, SearchGroup, SearchIntent, SearchKind } from "./search.repository.js";
export { imageLayerRepository } from "./image-layer.repository.js";

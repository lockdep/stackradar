// Request-validation schemas, re-exported for the controllers.

// Common schemas
export { uuidParamSchema } from "./common.schema.js";

// Kubernetes model schemas — see docs/adr/0004-image-as-the-unit-of-identity.md
export {
    workloadIdParamSchema,
    imageIdParamSchema,
    releaseIdParamSchema,
    workloadListQuerySchema,
    clusterScopeQuerySchema,
} from "./workload.schema.js";

// Job schemas
export { jobIdParamSchema } from "./job.schema.js";

// Cluster schemas
export {
    createClusterSchema,
    updateClusterSchema,
    clusterComponentsQuerySchema,
    clusterVulnerabilitiesQuerySchema,
    clusterVulnerabilityOccurrencesQuerySchema,
    clusterPackageOccurrencesQuerySchema,
    clusterRiskScoreQuerySchema,
    clusterRiskScoreFindingsQuerySchema,
    clusterIdParamSchema,
} from "./cluster.schema.js";

// Admin schemas
export {
    adminListQuerySchema,
    adminJobsQuerySchema,
    adminImagesQuerySchema,
    explorerImagesQuerySchema,
    explorerSbomsQuerySchema,
    explorerComponentsQuerySchema,
    adminOrgIdParamSchema,
    adminComponentIdParamSchema,
    parseFailureIdParamSchema,
    adminJobIdParamSchema,
    adminFeedParamSchema,
} from "./admin.schema.js";

// User schemas
export { createUserOrgSchema } from "./user.schema.js";

// Organization schemas
export {
    updateOrgSchema,
    updateAlertsSchema,
    updateMemberRoleSchema,
    createInviteSchema,
} from "./organization.schema.js";

// SBOM schemas
export {
    sbomIdParamSchema,
    sbomDocumentQuerySchema,
    uploadSbomQuerySchema,
    checkSbomQuerySchema,
} from "./sbom.schema.js";

// Scanner inventory schemas
export {
    inventoryReportSchema,
    SUPPORTED_INVENTORY_VERSIONS,
    isSupportedInventoryVersion,
} from "./inventory.schema.js";

// Chart repository schemas
export {
    chartRepositoryIdParamSchema,
    createChartRepositorySchema,
    updateChartRepositorySchema,
    discoverChartQuerySchema,
} from "./chart-repository.schema.js";

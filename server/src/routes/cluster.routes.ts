import { Router } from "express";
import { clusterController, requireOwnedCluster } from "../controllers/cluster.controller.js";
import { requireAdminOrOwner, requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";
import { requireMultiCluster } from "../middleware/edition.js";

const router = Router();

// All cluster routes require auth + org context
router.use(requireAuth, requireInternal, requireOrg);

// Every `:id` route resolves the cluster and proves the caller's org owns it
// before the handler runs — see `requireOwnedCluster`.
router.param("id", requireOwnedCluster);

// Cluster CRUD. Reads are member-accessible; mutations are admin/owner-only
// (the UI presents cluster management as admin functionality).
// Before `/:id`, or "names" would be resolved as a cluster id.
router.get("/names", clusterController.names);
// Every cluster's masked key metadata, for the org settings API keys tab.
router.get("/api-keys", clusterController.listApiKeys);
router.get("/", clusterController.list);
// The community edition manages one cluster — the one it runs in, created
// at start-up from `BOOTSTRAP_CLUSTER_*` — so creating another, or minting
// or revoking its key from a request, is refused there (`requireMultiCluster`).
router.post("/", requireAdminOrOwner, requireMultiCluster, clusterController.create);
router.get("/:id", clusterController.getById);
router.patch("/:id", requireAdminOrOwner, clusterController.update);
router.delete("/:id", requireAdminOrOwner, clusterController.delete);

// Which discovered workloads have no SBOM yet
router.get("/:id/coverage", clusterController.coverage);

// Distinct packages across the cluster's scanned images (paginated, searchable)
router.get("/:id/components", clusterController.components);

// The images and workloads one package version occurs in (the count drill-down)
router.get("/:id/components/occurrences", clusterController.componentOccurrences);

// The ecosystems those packages come from (the Packages tab's Ecosystem menu)
router.get("/:id/components/ecosystems", clusterController.componentEcosystems);

// Every vulnerability in the cluster, one row per advisory (filterable, paginated)
router.get("/:id/vulnerabilities", clusterController.vulnerabilities);

// The images and workloads one advisory affects (the count drill-down)
router.get("/:id/vulnerabilities/occurrences", clusterController.vulnerabilityOccurrences);

// The advisory metadata behind one listed row (the expand-row drill-down)
router.get("/:id/vulnerabilities/detail", clusterController.vulnerabilityDetail);

// Every scanned image's share of the cluster's Radar Score, largest first (paginated)
router.get("/:id/radar-score", clusterController.radarScore);

// The findings that add up to one image's share (the expand-row drill-down)
router.get("/:id/radar-score/findings", clusterController.radarScoreFindings);

// Cluster API key management. The GET returns masked metadata only (prefix +
// timestamps, never key material), so it stays member-visible; rotate and
// revoke change the credential and are admin/owner-only, and so is reveal —
// the plaintext, from its encrypted-at-rest copy (`lib/api-key-vault.ts`),
// audited on every call.
router.get("/:id/api-key", clusterController.getApiKey);
router.post("/:id/api-key", requireAdminOrOwner, requireMultiCluster, clusterController.rotateApiKey);
router.post("/:id/api-key/reveal", requireAdminOrOwner, clusterController.revealApiKey);
router.delete("/:id/api-key", requireAdminOrOwner, requireMultiCluster, clusterController.revokeApiKey);

export default router;

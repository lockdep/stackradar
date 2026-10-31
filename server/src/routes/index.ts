import { Router } from "express";
import healthRoutes from "./health.routes.js";
import workloadRoutes from "./workload.routes.js";
import namespaceRoutes from "./namespace.routes.js";
import imageRoutes from "./image.routes.js";
import releaseRoutes from "./release.routes.js";
import sbomRoutes from "./sbom.routes.js";
import vulnerabilityRoutes from "./vulnerability.routes.js";
import userRoutes from "./user.routes.js";
import organizationRoutes from "./organization.routes.js";
import inviteRoutes from "./invite.routes.js";
import jobRoutes from "./job.routes.js";
import clusterRoutes from "./cluster.routes.js";
import componentRoutes from "./component.routes.js";
import searchRoutes from "./search.routes.js";
import adminRoutes from "./admin.routes.js";
import metricsRoutes from "./metrics.routes.js";
import remediationRoutes from "./remediation.routes.js";
import feedRoutes from "./feed.routes.js";
import chartRepositoryRoutes from "./chart-repository.routes.js";
import riskScoreRoutes from "./risk-score.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/users", userRoutes);
router.use("/organizations", organizationRoutes);
router.use("/invites", inviteRoutes);

/* The Kubernetes model. `/projects` is gone: the client already routed
   `/clusters/[id]/workloads` while the API said projects, and the API caught
   up to the URL; both now say `containers`, the unit being one
   `workload_containers` row. Namespace, release and image are lenses over the
   same `workload_containers` rows, not hierarchies. GitOps applications are
   the fourth lens in the model but have no list route: the release and image
   pages read them through their own rows. */
router.use("/containers", workloadRoutes);
router.use("/namespaces", namespaceRoutes);
router.use("/releases", releaseRoutes);
router.use("/images", imageRoutes);

/* The remediation surface — one ranked, read-only list of the moves the
   product can recommend, a lens over the same images the four lenses above
   group. */
router.use("/remediation", remediationRoutes);
/* The activity feed — a second reader of `activity_events`, day-blocked in
   the view. */
router.use("/feed", feedRoutes);
/* Chart repository settings — feeds the suggestion feed's unmeasured band. */
router.use("/chart-repositories", chartRepositoryRoutes);

router.use("/sboms", sbomRoutes);
router.use("/vulnerabilities", vulnerabilityRoutes);
/* The org-wide Risk Score breakdown and the finding-level top-N the weekly
   digest's "Start here" draws from — every cluster's Risk Score tab folded
   into one, as `/vulnerabilities`
   is of the Vulnerabilities tabs. */
router.use("/risk-score", riskScoreRoutes);
/* The org-wide Packages page — every cluster's Packages tab folded into one,
   as `/vulnerabilities` is of the Vulnerabilities tabs. */
router.use("/components", componentRoutes);
/* The global search palette — one request over vulnerabilities, packages,
   images, workloads and clusters of the caller's org, grouped and ranked. */
router.use("/search", searchRoutes);
router.use("/jobs", jobRoutes);
router.use("/clusters", clusterRoutes);
router.use("/admin", adminRoutes);
router.use("/metrics", metricsRoutes);

/* Billing, feedback and terms are mounted by `cloud/index.ts` when the
   edition has them; in the community edition they are 404s, which is the
   honest answer. */

export default router;

import { Router } from "express";
import { prometheusController } from "../controllers/prometheus.controller.js";

/**
 * Prometheus scrape endpoint. Distinct from `metrics.routes.ts`, which serves
 * the product's per-org metric snapshots to the UI and is authenticated —
 * this one is the operational exposition format read by kube-prometheus-stack.
 *
 * Unauthenticated by design, and safe because it is unreachable from outside
 * the cluster: the `server-api` Ingress routes four exact `/v1/*` paths and
 * nothing else, so this is only addressable through the ClusterIP Service.
 * It exposes no org, user or vulnerability data — only mirror freshness
 * counters and the process's own runtime stats.
 */
const router = Router();

router.get("/", prometheusController.scrape);

export default router;

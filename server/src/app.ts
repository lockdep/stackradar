import express, { type Express } from "express";
import type { IncomingMessage, ServerResponse } from "http";
import { pinoHttp, type Options } from "pino-http";
import routes from "./routes/index.js";
import publicRoutes from "./routes/public.routes.js";
import prometheusRoutes from "./routes/prometheus.routes.js";
import matchRoutes from "./routes/match.routes.js";
import knownImagesRoutes from "./routes/known-images.routes.js";
import { errorHandler } from "./middleware/error-handler.js";
import { logger, redactedPaths } from "./lib/logger.js";
import { config } from "./config/index.js";
import { edition, type Capabilities } from "./edition.js";
import { mountCloud } from "./cloud/index.js";

const httpLoggerOptions: Options = {
  logger,
  genReqId: (req: IncomingMessage) =>
    (req.headers["x-request-id"] as string) || crypto.randomUUID(),
  redact: redactedPaths,
  customLogLevel: (
    _req: IncomingMessage,
    res: ServerResponse,
    err?: Error
  ) => {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req: IncomingMessage, _res: ServerResponse) => {
    return `${req.method} ${req.url} completed`;
  },
  customErrorMessage: (
    _req: IncomingMessage,
    _res: ServerResponse,
    err: Error
  ) => {
    return `Request failed: ${err.message}`;
  },
  // Don't log health checks or the Prometheus scrape in production — between
  // the kubelet probes and a 30s scrape interval they would otherwise be the
  // majority of the log volume, and none of it says anything.
  autoLogging: {
    ignore: (req: IncomingMessage) => {
      if (config.isProduction) {
        return (
          (req.url?.startsWith("/api/health") ?? false) ||
          (req.url?.startsWith("/metrics") ?? false)
        );
      }
      return false;
    },
  },
};

/**
 * The Express app for a given edition. The default export is the process's
 * own (`src/edition.ts`); tests build a community app to assert what is
 * *not* there.
 */
export function createApp(caps: Capabilities = edition): Express {
  const app = express();

  app.use(pinoHttp(httpLoggerOptions));

  // The cloud's surface — billing, the Stripe and Resend webhooks, feedback,
  // terms, the unsubscribe links — in one call, before the JSON parser: the
  // webhooks verify signatures over the raw body, so they carry their own
  // parser, and the cloud routers that take JSON carry theirs. In the
  // community edition nothing is mounted and every one of those paths is a
  // 404, which is the honest answer.
  if (caps.isCloud) {
    mountCloud(app);
  } else {
    logger.info("Community edition: billing, feedback, terms and the email webhooks are not mounted");
  }

  app.use(express.json({ limit: "10mb" }));

  // Which edition this is and what it can do (`src/edition.ts`). No
  // credential: nothing here is secret, and the client keeps a mirror of
  // the same object (`client/src/lib/edition.ts`) that this lets it verify.
  app.get("/api/edition", (_req, res) => {
    res.json(caps);
  });

  // Prometheus scrape target (cluster-only — not routed by the api.stackradar.io
  // ingress, which allow-lists a handful of exact /v1 paths). Mounted at the top level
  // rather than under /api because that is where a ServiceMonitor looks by default.
  app.use("/metrics", prometheusRoutes);

  // Public API (exposed via api.stackradar.io ingress)
  app.use("/v1", publicRoutes);

  // The chart index's matcher call (cluster-only; the production Ingress routes
  // exact /v1 paths and nothing under /internal). Keyed by its own secret and
  // mounted only when that secret exists — an unset key means the endpoint does
  // not exist, not that it is open. Outside the /api router on purpose: that
  // one trusts user-identity headers behind INTERNAL_SERVICE_KEY, and this
  // caller must never be able to present those.
  if (config.match.serviceKey) {
    app.use("/internal/match", matchRoutes);
    // Same caller, same key, same direction: the chart index's known public
    // image chains, for base-image detection (routes/known-images.routes.ts).
    app.use("/internal/known-images", knownImagesRoutes);
  } else {
    logger.info("MATCH_SERVICE_KEY is not set: POST /internal/match is not mounted");
  }

  // Internal API (cluster-only, used by Next.js BFF)
  app.use("/api", routes);

  // Error handling (must be last)
  app.use(errorHandler);

  return app;
}

const app = createApp();

export default app;

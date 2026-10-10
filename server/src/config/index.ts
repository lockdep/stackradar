import { edition } from "../edition.js";
import {
    BOOTSTRAP_CLUSTER_API_KEY_VAR,
    BOOTSTRAP_CLUSTER_ID_VAR,
    readBootstrapCluster,
} from "../lib/bootstrap-cluster.js";

export const config = {
    port: Number(process.env.PORT) || 8080,
    nodeEnv: process.env.NODE_ENV || "development",
    isProduction: process.env.NODE_ENV === "production",
    appUrl: process.env.APP_URL || "http://localhost:3000",
    // Marketing site; emails link to its docs.
    siteUrl: process.env.SITE_URL || "https://stackradar.io",
    database: {
        url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5444/server",
        // Max connections in this process's pool. The API server and the job
        // worker are separate processes, so each gets its own pool of this
        // size — their combined total (plus the EPSS/KEV/Artifact Hub CLI
        // runs, which share this module) must stay under Postgres
        // max_connections (default 100).
        poolMax: Number(process.env.DB_POOL_MAX) || 10,
        // Seconds (postgres.js `connect_timeout`). Fail fast when Postgres is
        // unreachable instead of letting requests queue behind a dead dial.
        connectTimeoutSeconds: Number(process.env.DB_CONNECT_TIMEOUT_SECONDS) || 10,
        // Milliseconds, applied as the session's `statement_timeout`. This is
        // a backstop against queries that hang forever (the findings
        // aggregations are the ones that will someday do it), not a latency
        // SLO — the default is sized so the heaviest legitimate statements
        // survive: the EPSS apply's first-run UPDATE recomputes the generated
        // risk_score across the whole ~300k-row mirror, and a large SBOM
        // subtree delete walks tens of thousands of component rows. Tighten
        // per deploy via env if the API pods should be stricter.
        statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 120_000,
        // Milliseconds, applied as `idle_in_transaction_session_timeout`. A
        // wedged inventory transaction must not hold its full-set-replacement
        // locks indefinitely; in-transaction JS gaps (e.g. the EPSS parser
        // streaming batches) are milliseconds, so 60s is generous.
        idleInTransactionTimeoutMs: Number(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS) || 60_000,
        // Per-session planner/executor settings, sent as startup parameters
        // so every pooled connection gets them (db plan item 2).
        //
        // `jit` off: the finding rollups are one big statement each, and on
        // the dev instance JIT compilation was 16.8 s of a 75 s run
        // (inlining + optimisation + emission of 83 functions) for a query
        // whose per-row work is trivial. Nothing this server runs is the
        // long-running analytical scan JIT pays off on.
        //
        // `work_mem`: the instance default (2 MB) made the rollup's hash join
        // split into 128 batches and write ~200 MB of temp per call. Budget
        // is per sort/hash node, so `DB_POOL_MAX` × this × a few nodes must
        // fit the instance's RAM; 32 MB is right for the 4 GB dev instance,
        // do not go above 64 MB there.
        jit: process.env.DB_JIT || "off",
        workMem: process.env.DB_WORK_MEM || "32MB",
        // PEM contents (not a path) of the CA that signed the Postgres
        // server's certificate — DO managed Postgres publishes one per
        // cluster. When set, connections verify the chain against it
        // (security review I6); when unset, TLS use follows the URL's
        // `sslmode` alone, which encrypts but does not authenticate the CA.
        caCert: process.env.DATABASE_CA_CERT || "",
    },
    stripe: {
        secretKey: process.env.STRIPE_SECRET_KEY || "",
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
        // No price IDs: prices are resolved from Stripe by lookup key
        // (lib/stripe-prices.ts), so the catalog is one convention in every
        // environment rather than eight secrets. The old STRIPE_PRO_PRICE_ID
        // / STRIPE_TEAM_PRICE_ID are ignored.
    },
    chartRepo: {
        // Byte ceiling on a chart repository's index.yaml. User-supplied URL,
        // synchronous parse: this bounds both memory and parse time. See
        // lib/chart-repo.ts.
        maxIndexBytes: Number(process.env.CHART_REPO_MAX_INDEX_BYTES) || 5 * 1024 * 1024,
    },
    email: {
        // Resend API key. Empty means "email is not configured": sends are
        // skipped (not failed) and logged, so a dev environment without a
        // key still creates invites — the admin falls back to sharing
        // inviteUrl by hand.
        resendApiKey: process.env.RESEND_API_KEY || "",
        // Signing secret for the Resend → /v1/webhooks/resend events
        // (Svix format, `whsec_...`). Empty disables the webhook (401).
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET || "",
        // Sender, on a dedicated transactional subdomain so a marketing
        // complaint never hurts invite deliverability.
        from: process.env.EMAIL_FROM || "StackRadar <no-reply@mail.stackradar.io>",
        replyTo: process.env.EMAIL_REPLY_TO || "",
        // HMAC key for the digest's and the alerts' unsubscribe links
        // (`lib/unsubscribe-token.ts`). Falls back to the internal service key so
        // a deploy that sets nothing still signs; set it separately so
        // rotating one does not invalidate the other.
        digestUnsubscribeSecret: process.env.DIGEST_UNSUBSCRIBE_SECRET || process.env.INTERNAL_SERVICE_KEY || "",
    },
    /**
     * Reddit Ads Conversions API v3 (`services/reddit-conversions.service.ts`).
     * Pixel id and token both empty (the local and dev default) means
     * conversions are logged and skipped. The pixel id (`a2_...`) is an
     * identifier and lives in the server ConfigMap; the "conversion access
     * token" from Reddit Ads > Events Manager is a secret.
     *
     * `conversionsApiUrl` is the v3 pixels base; the pixel id and
     * `/conversion_events` are appended. Overridable so a path change is a
     * redeploy of an env var, not a release. `testId` is a Test ID generated
     * in Events Manager's test-events view: while set, Reddit shows the
     * events there instead of counting them — set it while checking the
     * wiring, then unset.
     */
    reddit: {
        pixelId: process.env.REDDIT_PIXEL_ID || "",
        conversionsToken: process.env.REDDIT_CONVERSIONS_TOKEN || "",
        conversionsApiUrl: process.env.REDDIT_CONVERSIONS_API_URL || "https://ads-api.reddit.com/api/v3/pixels",
        testId: process.env.REDDIT_CONVERSIONS_TEST_ID || "",
    },
    /**
     * Founder alerts (`services/founder-alert.service.ts`): an email and/or
     * Slack message to the operator when someone signs up and when their
     * first cluster reports in, so every real sign-up gets a personal reply
     * within a day. `email` is the address the alert goes to (over Resend,
     * so it needs RESEND_API_KEY too); `slackWebhookUrl` is a Slack incoming
     * webhook (a secret). Either alone is enough; both empty (the local
     * default) means alerts are logged and skipped.
     */
    founderAlerts: {
        email: process.env.FOUNDER_ALERT_EMAIL || "",
        slackWebhookUrl: process.env.FOUNDER_ALERT_SLACK_WEBHOOK_URL || "",
    },
    /**
     * Server-side product analytics (`services/posthog.service.ts`): the
     * funnel events the browser cannot see — `signup_completed` at setup and
     * `first_sbom_received` on an org's first inventory report — captured
     * against the same PostHog project as the marketing site and dashboard.
     * `apiKey` is the project token (the same public `phc_...` the landing
     * page ships in its JavaScript), so it lives in the ConfigMap, not a
     * secret; empty (the local default) means events are logged and
     * skipped. `host` is the EU ingestion host, overridable for a proxy.
     */
    posthog: {
        apiKey: process.env.POSTHOG_API_KEY || "",
        host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com",
    },
    // Where the server itself is reachable by a browser — api.stackradar.io in
    // production. The digest's and the alerts' unsubscribe links point here
    // (`/v1`), not at the client: the BFF would demand a session, and an
    // unsubscribe link must work from a mail client with none. Unset in
    // production means every mail carries a localhost link — set it.
    publicApiUrl: process.env.PUBLIC_API_URL || "http://localhost:8080",
    /**
     * `POST /internal/match` — the charts index's only call into the product
     * (`docs/contracts/match-endpoint.md`). The router is mounted only when
     * `serviceKey` is set; `maxComponents` caps one request's component list
     * (a 413 above it) so a caller cannot ask for a 300k-key lookup.
     */
    /**
     * The public chart index, as a source of measured chart-upgrade deltas
     * (`lib/chart-index-client.ts`). Both unset — the default — and the Fixes
     * page behaves exactly as before: an unmeasured chart bump stays
     * unmeasured. The key is `DELTA_SERVICE_KEY` on the charts site.
     */
    chartIndex: {
        url: process.env.CHART_INDEX_URL || "",
        deltaKey: process.env.CHART_INDEX_DELTA_KEY || "",
    },
    match: {
        serviceKey: process.env.MATCH_SERVICE_KEY || "",
        maxComponents: Number(process.env.MATCH_MAX_COMPONENTS) || 20_000,
        // Ceiling on candidate rows one match key may return after release
        // scoping. A key over it is logged and treated as having no
        // candidates rather than pulling tens of megabytes of version lists
        // into the heap — the 2026-09-12 server OOM was four concurrent
        // requests each carrying an Ubuntu kernel key (db plan item 4).
        maxCandidatesPerKey: Number(process.env.MATCH_MAX_CANDIDATES_PER_KEY) || 20_000,
    },
    /**
     * `lib/api-key-vault.ts`: the key under which scanner API keys are stored
     * encrypted, next to their hash, so an admin can reveal the current key
     * again. 32 bytes as 64 hex characters (`openssl rand -hex 32`) or
     * base64. Empty means the vault is off: keys are hash-only as before,
     * and `POST /api/clusters/:id/api-key/reveal` answers 503. Rotating this
     * value makes every key minted under the old one unrevealable (a 409 —
     * the user rotates the cluster key); authentication is unaffected.
     */
    apiKeys: {
        encryptionKey: process.env.API_KEY_ENCRYPTION_KEY || "",
    },
    scanner: {
        // Fleet management over the only channel the server has to a running
        // agent — the heartbeat response. Both are additive: an agent that
        // predates them ignores them, a newer one logs them and shows them on
        // its /healthz. Empty means "nothing to say", and the fields are
        // omitted from the response rather than sent blank.
        //
        // minVersion: the oldest scanner release the control plane still
        // fully supports. Raised when a wire format (inventory version, SBOM
        // spec) stops being accepted, so the fleet hears about it before the
        // 400s start. Must be a plain `major.minor.patch`.
        minVersion: process.env.SCANNER_MIN_VERSION || "",
        // message: a free-text operator notice — a deprecation date, a
        // maintenance window. The agent logs it at warn on every heartbeat,
        // so keep it short and take it down when it is no longer true.
        message: process.env.SCANNER_FLEET_MESSAGE || "",
    },
    /**
     * Migrations on boot (`db/migrate.ts`, open-source plan step 05).
     * `MIGRATE_ON_START=true` applies the Drizzle chain before the server
     * listens, under an advisory lock so replicas serialise; the default
     * chart install relies on it. `MIGRATE_EXIT_AFTER=true` applies it and
     * exits 0 without listening — the same image as a one-shot initializer
     * Job — and implies the first, so a Job sets one variable. The cloud
     * sets neither and keeps its PreSync migration Jobs.
     */
    migrations: {
        onStart: process.env.MIGRATE_ON_START === "true" || process.env.MIGRATE_EXIT_AFTER === "true",
        exitAfter: process.env.MIGRATE_EXIT_AFTER === "true",
    },
} as const;

/**
 * The optional integrations, computed from env presence. These are optional
 * in **both** editions and never gate product behaviour — that is
 * `edition`'s job (`src/edition.ts`). What they decide is whether a side
 * effect happens or is logged and skipped: an unset PostHog key means no
 * funnel event, not a different product.
 *
 * `email` absent on the cloud is a misconfiguration the readiness probe
 * reports (`cloudConfigProblems`); in the community edition it is the
 * normal state, and every mail becomes a log line.
 */
export const integrations = Object.freeze({
    /** Server-side PostHog events (`services/posthog.service.ts`). */
    analytics: Boolean(config.posthog.apiKey),
    /** Transactional email over Resend (`cloud/email/`). */
    email: Boolean(config.email.resendApiKey),
    /** Measured chart-upgrade deltas from the public chart index (`lib/chart-index-client.ts`). */
    chartIndex: Boolean(config.chartIndex.url && config.chartIndex.deltaKey),
    /**
     * The nightly Artifact Hub mirror behind chart attribution
     * (`artifacthub-sync/`). On unless switched off: it downloads a ~25 MB
     * dump a day, which a self-hoster may not want. `artifacthub-sync --once`
     * exits 0 with a log line when this is false.
     */
    artifactHubSync: process.env.ARTIFACT_HUB_SYNC_ENABLED !== "false",
    /** The operator's sign-up alerts (`cloud/attribution/founder-alert.service.ts`). */
    founderAlerts: Boolean(config.founderAlerts.email || config.founderAlerts.slackWebhookUrl),
});

/**
 * What every edition needs to boot. `API_KEY_ENCRYPTION_KEY` is here on
 * purpose: without it a self-hosted install would boot and mint scanner
 * keys that can never be revealed, and the first time anyone noticed
 * would be the rotation that follows. The cloud-only secrets (Stripe,
 * Resend) are *not* boot blockers — the cloud edition starts without them
 * and its readiness probe says what is missing (`cloudConfigProblems`).
 */
const REQUIRED_ENV_VARS = [
    "DATABASE_URL",
    "INTERNAL_SERVICE_KEY",
    "API_KEY_ENCRYPTION_KEY",
] as const;

export interface CloudConfigProblems {
    /** Missing configuration the cloud cannot serve without: the pod is not ready. */
    blocking: string[];
    /** Missing configuration the cloud degrades without: reported, still ready. */
    warnings: string[];
}

/**
 * The cloud edition's configuration check, for the readiness probe. Stripe
 * is blocking — billing with no key is a product that takes money nowhere.
 * Resend is a warning while the production mailbox is still being set up;
 * flip it to blocking once `RESEND_API_KEY` is on both clusters. Empty in
 * the community edition, where none of this applies.
 */
export function cloudConfigProblems(
    cfg: { stripe: { secretKey: string; webhookSecret: string }; email: { resendApiKey: string; webhookSecret: string } } = config,
    caps: { billing: boolean; alerting: "webhook" | "full" } = edition,
): CloudConfigProblems {
    const blocking: string[] = [];
    const warnings: string[] = [];
    if (caps.billing) {
        if (!cfg.stripe.secretKey) blocking.push("STRIPE_SECRET_KEY is not set");
        if (!cfg.stripe.webhookSecret) blocking.push("STRIPE_WEBHOOK_SECRET is not set");
    }
    if (caps.alerting === "full") {
        if (!cfg.email.resendApiKey) warnings.push("RESEND_API_KEY is not set: invites, digests and alert email are logged, not sent");
        if (!cfg.email.webhookSecret) warnings.push("RESEND_WEBHOOK_SECRET is not set: email delivery events are refused");
    }
    return { blocking, warnings };
}

/**
 * The community edition's configuration check, for the readiness probe.
 * Without the bootstrap credential the install has an organisation and no
 * cluster — and no way to add one, since that is what the edition refuses
 * (`middleware/edition.ts`) — so a pod running that way is reported, not
 * failed: it serves, it just scans nothing. Empty on the cloud, where
 * clusters are created by their tenants.
 */
export function communityConfigProblems(
    env: Record<string, string | undefined> = process.env,
    caps: { multiCluster: boolean } = edition,
): CloudConfigProblems {
    const warnings: string[] = [];
    if (!caps.multiCluster) {
        let configured = false;
        try {
            configured = readBootstrapCluster(env) !== null;
        } catch {
            // A half-configured pair is refused at boot (`validateConfig`);
            // a process that got this far has both or neither.
        }
        if (!configured) {
            warnings.push(
                `${BOOTSTRAP_CLUSTER_ID_VAR} / ${BOOTSTRAP_CLUSTER_API_KEY_VAR} are not set: this install has no cluster and no scanner can connect`,
            );
        }
    }
    return { blocking: [], warnings };
}

/**
 * The production rule for the database connection's TLS (security review
 * I6): the URL must say what it wants. `sslmode=require` (or `verify-ca` /
 * `verify-full`, the goal state with `DATABASE_CA_CERT`) is the cloud's
 * only answer. The community edition also accepts an explicit
 * `sslmode=prefer` — TLS when the server offers it, plaintext when it does
 * not — because the Docker Compose quickstart and the chart's bundled
 * Postgres (open-source plan steps 07–08) run a plain `postgres:18-alpine`
 * on a private network, and a self-hoster who wrote `prefer` made a
 * choice. A URL with no `sslmode` at all is refused in both editions: that
 * one is not a choice, it is the driver's default (`ssl: false`) silently
 * accepting a plaintext session to a server that may be across the
 * internet. `sslmode=disable` is deliberately *not* accepted: postgres.js
 * treats any non-false value as "negotiate TLS", so `disable` fails to
 * connect to a server without TLS rather than disabling anything.
 *
 * Returns the problem as a sentence, or null. Pure, for the unit test.
 */
export function databaseTlsProblem(
    url: string,
    opts: { isProduction: boolean; isCloud: boolean },
): string | null {
    if (!opts.isProduction) return null;
    const mode = /[?&]sslmode=([a-z-]+)\b/.exec(url)?.[1];
    if (mode === "require" || mode === "verify-ca" || mode === "verify-full") return null;
    if (mode === "prefer" && !opts.isCloud) return null;
    return opts.isCloud
        ? "DATABASE_URL must set sslmode=require (or verify-ca/verify-full) in production"
        : "DATABASE_URL must set sslmode=require (or verify-ca/verify-full) in production; sslmode=prefer is accepted for a Postgres on a private network, such as the Compose quickstart's";
}

export function validateConfig(): void {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    // The community edition's scanner credential: both of the pair or
    // neither, and well-formed — a half-configured pair is a scanner that
    // cannot authenticate, not an install with a feature off. Throws a
    // `BootstrapClusterError` naming the variable.
    readBootstrapCluster(process.env);

    const tlsProblem = databaseTlsProblem(config.database.url, {
        isProduction: config.isProduction,
        isCloud: edition.isCloud,
    });
    if (tlsProblem) {
        throw new Error(tlsProblem);
    }
}

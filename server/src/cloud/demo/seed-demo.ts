#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * Seed the live-demo fixture — `docs/live-demo/` step 01.
 *
 * Usage:
 *   pnpm seed-demo                       Find-or-create everything; idempotent.
 *   pnpm seed-demo --rotate-key          Also revoke the cluster's keys and mint a new one.
 *   node dist/src/cloud/demo/seed-demo.js   The same, from the built server image
 *                                        (a one-off Job in production — step 05).
 *
 * The scanner key is printed **once**: on the run that creates the cluster,
 * or on `--rotate-key`. Nothing is ever deleted.
 */

import "dotenv/config";
import { seedDemo, DEMO_USER_EMAIL, DEMO_ORG_SLUG, DEMO_CLUSTER_NAME } from "./demo-seed.service.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Seed the live-demo org, user, membership, terms acceptance, cluster and key.

Usage:
  pnpm seed-demo [--rotate-key]

Options:
  --rotate-key   Revoke the demo cluster's active scanner keys and mint a new
                 one (for when the key was lost). Leaves exactly one active key.
  --help         This message.

Environment Variables:
  DATABASE_URL   PostgreSQL connection string (the server database)
  LOG_LEVEL      Log level (default: info)

Idempotent: keyed on organizations.slug = '${DEMO_ORG_SLUG}' AND demo = true,
user ${DEMO_USER_EMAIL}, cluster '${DEMO_CLUSTER_NAME}'. Never deletes.
`);
    process.exit(0);
}

const unknown = args.filter((a) => a !== "--rotate-key");
if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}. See --help.`);
    process.exit(1);
}

try {
    const result = await seedDemo({ rotateKey: args.includes("--rotate-key") });

    console.log("");
    console.log("Demo fixture");
    console.log(`  user     ${result.userId}  (${DEMO_USER_EMAIL})${result.created.user ? "  [created]" : ""}`);
    console.log(`  org      ${result.orgId}  (slug: ${DEMO_ORG_SLUG})${result.created.org ? "  [created]" : ""}`);
    console.log(`  cluster  ${result.clusterId}  (${DEMO_CLUSTER_NAME})${result.created.cluster ? "  [created]" : ""}`);
    if (result.apiKey) {
        console.log("");
        console.log("Scanner API key — shown once, store it now:");
        console.log("");
        console.log(`  ${result.apiKey}`);
        console.log("");
    } else {
        console.log("");
        console.log("Scanner API key: unchanged (not shown). Lost it? Re-run with --rotate-key.");
    }
    process.exit(0);
} catch (err) {
    console.error("Demo seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
}

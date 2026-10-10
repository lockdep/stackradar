#!/usr/bin/env node
/**
 * The cloud boundary check (docs/open-source-plan-2026-10-10.md step 02).
 *
 * `server/src/cloud/` and `client/src/cloud/` are source-available under
 * the StackRadar Cloud Licence; everything else is AGPL-3.0-only. Two
 * licences in one repo only work while the line between them is visible
 * and mechanical, so this script fails when:
 *
 *  1. a file under a cloud directory lacks the SPDX header
 *     (`// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud`),
 *  2. a file outside a cloud directory carries that header,
 *  3. a cloud directory has no `LICENSE` file,
 *  4. a file outside a cloud directory imports from inside one, other than
 *     the designated mount points listed in ALLOWED_IMPORTERS — the one
 *     place per process where the AGPL core reaches the cloud, by name.
 *     (The other direction, cloud importing core, is fine: the cloud is
 *     built on the core.)
 *
 * No dependencies; runs on bare node from a bare checkout:
 *
 *   node scripts/check-cloud-boundary.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER = "// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud";

/** Per app: where the cloud lives, where the sources are, and who may import it from outside. */
const APPS = [
    {
        name: "server",
        src: "server/src",
        cloud: "server/src/cloud",
        // `app.ts` mounts the HTTP surface, `jobs/job-worker.ts` enables the hooks and
        // schedules the cloud's crons; both only when `edition.isCloud`.
        allowedImporters: ["server/src/app.ts", "server/src/jobs/job-worker.ts"],
        // The cloud's own test files live with the rest of the suite.
        extraTrees: ["server/tests"],
    },
    {
        name: "client",
        src: "client/src",
        cloud: "client/src/cloud",
        // The core reaches the cloud through its barrel only (`@/cloud`), at
        // the seams that render a cloud surface behind an `edition` check,
        // plus the Next.js route files that must live under `app/` and only
        // re-export a cloud handler.
        allowedImporters: [
            "client/src/app/layout.tsx",
            "client/src/app/(app)/AppShell.tsx",
            "client/src/app/(app)/admin/page.tsx",
            "client/src/app/demo/enter/route.ts",
            "client/src/app/login/page.tsx",
            "client/src/components/Sidebar.tsx",
            "client/src/components/providers/OrganizationProvider.tsx",
            "client/src/components/ui/OrganizationSelector.tsx",
            "client/src/views/OrganizationSettingsView.tsx",
        ],
        extraTrees: [],
    },
];

const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|vi\.mock\(\s*)["']([^"']+)["']/g;

let failed = false;
function fail(msg) {
    console.error(`\nBOUNDARY: ${msg}`);
    failed = true;
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (SOURCE_EXT.test(entry)) yield full;
    }
}

function rel(path) {
    return relative(ROOT, path).split("\\").join("/");
}

for (const app of APPS) {
    const cloudDir = join(ROOT, app.cloud);
    if (!existsSync(cloudDir)) {
        console.log(`--   ${app.name}: no ${app.cloud} directory`);
        continue;
    }
    if (!existsSync(join(cloudDir, "LICENSE"))) fail(`${app.cloud}/LICENSE is missing`);

    const trees = [join(ROOT, app.src), ...app.extraTrees.map((t) => join(ROOT, t))];
    let files = 0;
    for (const tree of trees) {
        if (!existsSync(tree)) continue;
        for (const file of walk(tree)) {
            files++;
            const r = rel(file);
            const inCloud = r.startsWith(app.cloud + "/");
            const text = readFileSync(file, "utf8");
            const hasHeader = text.split("\n").slice(0, 2).some((line) => line.trim() === HEADER);

            if (inCloud && !hasHeader) fail(`${r} is under ${app.cloud} but lacks the header \`${HEADER}\``);
            if (!inCloud && hasHeader) fail(`${r} carries the cloud licence header but is outside ${app.cloud}`);
            if (inCloud) continue;

            // Imports from outside into the cloud.
            for (const m of text.matchAll(IMPORT)) {
                const spec = m[1];
                let target = null;
                if (spec.startsWith("@/cloud")) target = `${app.src}/cloud${spec.slice("@/cloud".length)}`;
                else if (spec.startsWith(".")) {
                    const resolved = rel(join(dirname(file), spec));
                    if (resolved.startsWith(app.cloud + "/") || resolved === app.cloud) target = resolved;
                }
                if (!target) continue;
                const isTest = /\.test\.tsx?$/.test(r) || r.startsWith(app.name + "/tests/");
                if (isTest) continue; // tests may exercise the cloud directly
                if (!app.allowedImporters.includes(r)) {
                    fail(`${r} imports the cloud (\`${spec}\`); only ${app.allowedImporters.join(", ")} may — route it through \`cloudHooks\` or add it to ALLOWED_IMPORTERS deliberately`);
                } else if (app.name === "client" && spec !== "@/cloud" && !r.startsWith("client/src/app/demo/")) {
                    fail(`${r} imports \`${spec}\`; outside the cloud, import its barrel \`@/cloud\` only`);
                } else if (app.name === "server" && !/cloud\/index\.js$/.test(spec)) {
                    fail(`${r} imports \`${spec}\`; outside the cloud, import \`cloud/index.js\` only`);
                }
            }
        }
    }
    console.log(`OK   ${app.name}: ${files} files checked, ${app.cloud} headed and licensed, imports confined to ${app.allowedImporters.length} mount points`);
}

if (failed) {
    console.error("\nThe cloud boundary is the licence boundary; see docs/open-source-plan-2026-10-10.md §0.");
    process.exit(1);
}
console.log("\nCloud boundary intact.");

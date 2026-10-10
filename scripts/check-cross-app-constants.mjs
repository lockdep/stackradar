#!/usr/bin/env node
/**
 * Cross-app constant drift check.
 *
 * The apps are deliberately independent pnpm projects (no workspace,
 * no shared package — see the root CLAUDE.md), so a handful of constants
 * exist as honest copies with "must match the server" comments. This script
 * is what turns those comments into a CI gate. The server is the source of
 * truth in every pair; a failure means the *copy* (the client) must be
 * updated. The chart index and the landing site keep their own copies of
 * server files in their own repositories and gate them from their side
 * (they check out this repo in CI).
 *
 * A shared package was considered and rejected: it would couple three
 * independently-locked apps through a fourth artifact for the sake of ~40
 * lines of constants, and the copies drift rarely and loudly (a moved band
 * threshold is a product decision, not a refactor side-effect).
 *
 * What is compared (extracted from the TS source with small parsers, so
 * unrelated edits to the files never false-positive):
 *
 *  1. RISK_BANDS   server/src/db/risk-model.ts  ⇄  client/src/lib/risk.ts
 *     Ordered list of { min, band } — thresholds and names, in order.
 *  2. RiskRollup   server/src/db/risk.ts        ⇄  client/src/lib/risk.ts
 *     Interface field names and (whitespace-normalised) types.
 *  3. PLAN_LIMITS  server/src/config/plans.ts   ⇄
 *                  client/src/components/organization-settings/constants.ts
 *     Per-plan numeric limits. Compared on the server's keys only: the
 *     client copy carries extra display-only fields (`retention`,
 *     `sbomsStored`) that have no server counterpart, and those are allowed.
 *  4. MIGRATION_LOCK_KEY  server/src/db/migrate.ts  ⇄  client/scripts/migrate.mjs
 *     Both apps migrate one database under one advisory lock (open-source
 *     plan step 05); different keys would let a client and a server replica
 *     interleave DDL. And the client's journal location, which its two
 *     migrators must agree on:
 *       migrations.schema/table  client/drizzle.config.ts
 *                                ⇄ MIGRATIONS_SCHEMA/TABLE client/scripts/migrate.mjs
 *
 * No dependencies; runs on bare node from a bare checkout:
 *
 *   node scripts/check-cross-app-constants.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = {
    serverRiskModel: "server/src/db/risk-model.ts",
    serverRisk: "server/src/db/risk.ts",
    clientRisk: "client/src/lib/risk.ts",
    serverPlans: "server/src/config/plans.ts",
    clientPlans: "client/src/components/organization-settings/constants.ts",
};

function read(rel) {
    return readFileSync(join(ROOT, rel), "utf8");
}

/** Strip // line comments and /* … *​/ block comments so the parsers below
 *  only ever see code. Naive about comment markers inside string literals,
 *  which none of the extracted declarations contain. */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The body between the `{`/`[` that follows `marker` and its balanced close. */
function extractBlock(src, marker, rel) {
    const start = src.indexOf(marker);
    if (start === -1) {
        fail(`could not find \`${marker.trim()}\` in ${rel} — was it renamed? Update ${FILES_SELF}.`);
    }
    const openIdx = src.indexOf(marker) + marker.length - 1;
    const open = src[openIdx];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === open) depth++;
        else if (src[i] === close && --depth === 0) return src.slice(openIdx + 1, i);
    }
    fail(`unbalanced ${open}${close} after \`${marker.trim()}\` in ${rel}`);
}

const FILES_SELF = "scripts/check-cross-app-constants.mjs";

/** RISK_BANDS: ordered [{ min, band }] out of `const RISK_BANDS = [ … ]`. */
function extractRiskBands(rel) {
    const body = extractBlock(stripComments(read(rel)), "RISK_BANDS = [", rel);
    const bands = [...body.matchAll(/\{\s*min:\s*([\d.]+)\s*,\s*band:\s*['"](\w+)['"]\s*,?\s*\}/g)]
        .map((m) => ({ min: Number(m[1]), band: m[2] }));
    if (bands.length === 0) fail(`found RISK_BANDS in ${rel} but parsed no entries — format changed? Update ${FILES_SELF}.`);
    return bands;
}

/** RiskRollup: { fieldName: normalisedType } out of `interface RiskRollup { … }`. */
function extractRiskRollup(rel) {
    const body = extractBlock(stripComments(read(rel)), "interface RiskRollup {", rel);
    const fields = {};
    // Split on newlines at brace depth 0 so inline object types stay intact.
    let depth = 0;
    let current = "";
    const lines = [];
    for (const ch of body) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (ch === "\n" && depth === 0) {
            lines.push(current);
            current = "";
        } else current += ch;
    }
    lines.push(current);
    for (const line of lines) {
        const m = line.trim().match(/^(\w+)\??:\s*(.+?);?$/);
        if (m) fields[m[1]] = m[2].replace(/\s+/g, " ").replace(/;\s*}/g, " }").trim();
    }
    if (Object.keys(fields).length === 0) fail(`found RiskRollup in ${rel} but parsed no fields — format changed? Update ${FILES_SELF}.`);
    return fields;
}

/** PLAN_LIMITS: { plan: { key: number } } — numeric/Infinity values only. */
function extractPlanLimits(rel) {
    const body = extractBlock(stripComments(read(rel)), "PLAN_LIMITS = {", rel);
    const plans = {};
    for (const m of body.matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
        const limits = {};
        for (const kv of m[2].matchAll(/(\w+):\s*(Infinity|[\d.]+)\s*,?/g)) {
            limits[kv[1]] = kv[2] === "Infinity" ? Infinity : Number(kv[2]);
        }
        plans[m[1]] = limits;
    }
    if (Object.keys(plans).length === 0) fail(`found PLAN_LIMITS in ${rel} but parsed no plans — format changed? Update ${FILES_SELF}.`);
    return plans;
}

function show(v) {
    return JSON.stringify(v, (_k, val) => (val === Infinity ? "Infinity" : val), 4);
}

let failed = false;
function fail(msg) {
    console.error(`\nDRIFT: ${msg}`);
    failed = true;
}

function compare(name, serverFile, clientFile, serverVal, clientVal) {
    if (JSON.stringify(serverVal, (_k, v) => (v === Infinity ? "Infinity" : v)) ===
        JSON.stringify(clientVal, (_k, v) => (v === Infinity ? "Infinity" : v))) {
        console.log(`OK   ${name}: ${clientFile} matches ${serverFile}`);
        return;
    }
    fail(
        `${name} differs.\n` +
        `  server (source of truth) — ${serverFile}:\n${show(serverVal)}\n` +
        `  copy (fix this one)      — ${clientFile}:\n${show(clientVal)}`
    );
}

// 1. Risk bands — thresholds and names, in order.
compare(
    "RISK_BANDS",
    FILES.serverRiskModel,
    FILES.clientRisk,
    extractRiskBands(FILES.serverRiskModel),
    extractRiskBands(FILES.clientRisk)
);

// 2. RiskRollup — the API shape the client asserts it receives.
compare(
    "RiskRollup",
    FILES.serverRisk,
    FILES.clientRisk,
    extractRiskRollup(FILES.serverRisk),
    extractRiskRollup(FILES.clientRisk)
);

// 3. Plan limits — compared on the server's keys; client-only display
//    fields (retention, sbomsStored) are allowed to exist.
{
    const server = extractPlanLimits(FILES.serverPlans);
    const client = extractPlanLimits(FILES.clientPlans);
    const serverKeyed = {};
    const clientKeyed = {};
    for (const [plan, limits] of Object.entries(server)) {
        serverKeyed[plan] = limits;
        clientKeyed[plan] = {};
        for (const key of Object.keys(limits)) {
            clientKeyed[plan][key] = client[plan]?.[key];
        }
    }
    // A plan existing only on the client is drift too.
    for (const plan of Object.keys(client)) {
        if (!(plan in server)) clientKeyed[plan] = client[plan];
    }
    compare("PLAN_LIMITS", FILES.serverPlans, FILES.clientPlans, serverKeyed, clientKeyed);
}

// 4. The migration advisory lock, and the client's journal location.
/** The numeric literal out of `MIGRATION_LOCK_KEY = <digits with optional _>`. */
function extractLockKey(rel) {
    const m = stripComments(read(rel)).match(/MIGRATION_LOCK_KEY\s*=\s*([\d_]+)/);
    if (!m) fail(`could not find \`MIGRATION_LOCK_KEY = <number>\` in ${rel} — was it renamed? Update ${FILES_SELF}.`);
    return m ? Number(m[1].replace(/_/g, "")) : NaN;
}
compare(
    "MIGRATION_LOCK_KEY",
    "server/src/db/migrate.ts",
    "client/scripts/migrate.mjs",
    extractLockKey("server/src/db/migrate.ts"),
    extractLockKey("client/scripts/migrate.mjs")
);
{
    const cfg = stripComments(read("client/drizzle.config.ts"));
    const block = extractBlock(cfg, "migrations: {", "client/drizzle.config.ts");
    const fromConfig = {
        schema: block.match(/schema:\s*["']([^"']+)["']/)?.[1],
        table: block.match(/table:\s*["']([^"']+)["']/)?.[1],
    };
    const mjs = stripComments(read("client/scripts/migrate.mjs"));
    const fromScript = {
        schema: mjs.match(/MIGRATIONS_SCHEMA\s*=\s*["']([^"']+)["']/)?.[1],
        table: mjs.match(/MIGRATIONS_TABLE\s*=\s*["']([^"']+)["']/)?.[1],
    };
    compare("client migrations journal", "client/drizzle.config.ts", "client/scripts/migrate.mjs", fromConfig, fromScript);
}

if (failed) {
    console.error(
        "\nThe server file is the source of truth; update the copy to match" +
        "\n(and, for plan limits, the landing page's PricingSection — see the" +
        "\ncomment in client/src/components/organization-settings/constants.ts)."
    );
    process.exit(1);
}
console.log("\nAll cross-app constants match.");

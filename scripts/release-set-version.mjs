#!/usr/bin/env node
// Stamps one version into everything in this repository that carries it.
//
//   node scripts/release-set-version.mjs 0.2.0            # a release
//   node scripts/release-set-version.mjs 0.3.0-snapshot   # main after it
//   node scripts/release-set-version.mjs --check 0.2.0    # exit 1 if anything disagrees
//
// Server and client ship together under one number (RELEASING.md), so both
// package.json files get the same `version`. A stable release is also added
// to the defect template's version dropdown, which is how the issue form
// stays current without a post-release edit (Dependency-Track's post-release
// checklist does that by hand). Snapshots and prereleases are not listed:
// the dropdown already has "snapshot (built from main)".
//
// Bare node, no dependencies, like the other scripts/ checks: the release
// workflow runs it before `pnpm install` has happened anywhere.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["server/package.json", "client/package.json"];
const DEFECT_TEMPLATE = ".github/ISSUE_TEMPLATE/defect-report.yml";
const DROPDOWN_ID = "environment-stackradar-version";

// Semver core with an optional prerelease; no build metadata, because `+`
// is not legal in an OCI tag and the version becomes one.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

const args = process.argv.slice(2);
const check = args.includes("--check");
const version = args.find((a) => !a.startsWith("--"));

if (!version || !SEMVER.test(version)) {
    console.error(`usage: release-set-version.mjs [--check] <major.minor.patch[-prerelease]> (got ${JSON.stringify(version ?? "")})`);
    process.exit(2);
}

const stable = !version.includes("-");
let drift = 0;

for (const rel of PACKAGES) {
    const file = join(root, rel);
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.version === version) continue;
    if (check) {
        console.error(`${rel}: version is ${JSON.stringify(pkg.version)}, expected ${JSON.stringify(version)}`);
        drift++;
        continue;
    }
    // Rewrite only the version line so the rest of the file keeps its
    // formatting byte for byte (pnpm and npm both write 2-space JSON, but
    // a key order or trailing newline change would show up as noise).
    const text = readFileSync(file, "utf8");
    const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
    if (next === text) {
        console.error(`${rel}: no "version" field found to rewrite`);
        process.exit(1);
    }
    writeFileSync(file, next);
    console.log(`${rel}: ${pkg.version} -> ${version}`);
}

if (stable) {
    const file = join(root, DEFECT_TEMPLATE);
    const lines = readFileSync(file, "utf8").split("\n");
    // Find the dropdown by id, then its `options:` list; insert the new
    // version as the first entry unless it is already listed.
    const idAt = lines.findIndex((l) => l.trim() === `id: ${DROPDOWN_ID}`);
    const optAt = idAt < 0 ? -1 : lines.findIndex((l, i) => i > idAt && l.trim() === "options:");
    if (optAt < 0) {
        console.error(`${DEFECT_TEMPLATE}: no dropdown with id ${DROPDOWN_ID} and an options list`);
        process.exit(1);
    }
    const indent = /^(\s*)/.exec(lines[optAt])[1];
    const entry = `${indent}- ${version}`;
    let end = optAt + 1;
    while (end < lines.length && lines[end].startsWith(`${indent}- `)) end++;
    const listed = lines.slice(optAt + 1, end).some((l) => l.trim() === `- ${version}`);
    if (!listed) {
        if (check) {
            console.error(`${DEFECT_TEMPLATE}: ${version} is not in the StackRadar Version dropdown`);
            drift++;
        } else {
            lines.splice(optAt + 1, 0, entry);
            writeFileSync(file, lines.join("\n"));
            console.log(`${DEFECT_TEMPLATE}: added ${version} to the version dropdown`);
        }
    }
}

if (check) {
    if (drift) process.exit(1);
    console.log(`everything carries ${version}`);
}

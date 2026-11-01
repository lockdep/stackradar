#!/usr/bin/env node
// Bumps the `stackradar` Helm chart (lockdep/helm-charts) to a new app
// release. publish.yaml runs it against a checkout of that repository and
// opens the result as a pull request; it can be run by hand the same way.
//
//   node scripts/release-bump-chart.mjs ../helm-charts/charts/stackradar 0.3.0
//   node scripts/release-bump-chart.mjs <chart dir> <app version> \
//       --migrations "server/0030_users_trial_consumed_at.sql client/0004_x.sql"
//
// What it rewrites, and nothing else:
//
//   Chart.yaml    `appVersion` (what `helm install` runs by default and what
//                 Artifact Hub shows as the app version), `version` (the
//                 chart's own), and the two StackRadar image tags in the
//                 `artifacthub.io/images` annotation.
//   UPGRADING.md  a new section for the chart version, saying where
//                 `appVersion` moved and whether the app release carries
//                 schema migrations.
//
// The chart README is generated (helm-docs, `make docs` in that repository),
// so it is not edited here. The chart version is decoupled from the app's
// (RELEASING.md): the bump takes `<app major>.<app minor>.0` when that is
// higher than the chart's current version — a chart for a new app minor
// shares its number — and the next chart patch otherwise.
//
// Refusals rather than guesses: a chart whose `appVersion` is already ahead
// of the release is not moved backwards, and an annotation that does not
// list both images at the current `appVersion` is drift to fix by hand, not
// something to paper over. An `appVersion` already at the release is a
// no-op (`changed=false`), so a re-run opens nothing.
//
// Outputs (`chart_version`, `previous_chart_version`, `previous_app_version`,
// `changed`) go to $GITHUB_OUTPUT when it is set, and to stdout always.
//
// Bare node, no dependencies, like the other scripts/ checks.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const IMAGES = ["stackradar-server", "stackradar-client"];
const RELEASES_URL = "https://github.com/lockdep/stackradar/releases/tag";

const args = process.argv.slice(2);
const positional = [];
let migrationsArg = "";
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--migrations") {
        migrationsArg = args[++i] ?? "";
    } else if (args[i].startsWith("--")) {
        fail(`unknown option ${args[i]}`, 2);
    } else {
        positional.push(args[i]);
    }
}
const [chartDir, appVersion] = positional;

if (!chartDir || !appVersion || !SEMVER.test(appVersion)) {
    fail("usage: release-bump-chart.mjs <chart dir> <major.minor.patch> [--migrations \"server/<file> client/<file> …\"]", 2);
}
if (appVersion.includes("-")) {
    fail(`${appVersion} is a prerelease; the chart's appVersion only ever names a stable release.`);
}

const chartFile = join(chartDir, "Chart.yaml");
const upgradingFile = join(chartDir, "UPGRADING.md");
for (const f of [chartFile, upgradingFile]) {
    if (!existsSync(f)) fail(`${f}: no such file; is ${chartDir} the chart directory?`);
}

// --- Chart.yaml -------------------------------------------------------------

let chart = readFileSync(chartFile, "utf8");

// Top-level keys only (no indent): the subchart dependency has its own
// `version:` four spaces in.
const versionLine = /^version:[ \t]+("?)([^"\s#]+)\1[ \t]*$/m;
const appVersionLine = /^appVersion:[ \t]+("?)([^"\s#]+)\1[ \t]*$/m;

const chartMatch = versionLine.exec(chart);
const appMatch = appVersionLine.exec(chart);
if (!chartMatch || !SEMVER.test(chartMatch[2])) fail(`${chartFile}: no top-level semver \`version:\``);
if (!appMatch || !SEMVER.test(appMatch[2])) fail(`${chartFile}: no top-level semver \`appVersion:\``);

const previousChartVersion = chartMatch[2];
const previousAppVersion = appMatch[2];

const order = compare(appVersion, previousAppVersion);
if (order < 0) {
    fail(`${chartFile}: appVersion is ${previousAppVersion}, ahead of ${appVersion}; a chart is never moved back to an older release.`);
}
if (order === 0) {
    console.log(`${chartFile}: appVersion is already ${appVersion}; nothing to do.`);
    emit({
        chart_version: previousChartVersion,
        previous_chart_version: previousChartVersion,
        previous_app_version: previousAppVersion,
        changed: "false",
    });
    process.exit(0);
}

const chartVersion = nextChartVersion(previousChartVersion, appVersion);

// The annotation lists the images the chart installs; Artifact Hub renders
// it. Both StackRadar images must be there at the old appVersion, or the
// annotation and the appVersion have already drifted apart.
for (const image of IMAGES) {
    const re = new RegExp(`^(\\s+image:\\s+\\S+/${image}):${escape(previousAppVersion)}[ \\t]*$`, "m");
    if (!re.test(chart)) {
        fail(`${chartFile}: the artifacthub.io/images annotation does not list ${image} at ${previousAppVersion}; align it with appVersion by hand first.`);
    }
    chart = chart.replace(re, `$1:${appVersion}`);
}

chart = chart.replace(versionLine, (_, q) => `version: ${q}${chartVersion}${q}`);
chart = chart.replace(appVersionLine, (_, q) => `appVersion: ${q}${appVersion}${q}`);
writeFileSync(chartFile, chart);
console.log(`${chartFile}: version ${previousChartVersion} -> ${chartVersion}, appVersion ${previousAppVersion} -> ${appVersion}, images retagged`);

// --- UPGRADING.md -----------------------------------------------------------

const upgrading = readFileSync(upgradingFile, "utf8");
const heading = `## ${chartVersion}`;
if (new RegExp(`^${escape(heading)}[ \\t]*$`, "m").test(upgrading)) {
    console.log(`${upgradingFile}: already has a ${heading} section; left alone.`);
} else {
    const firstSection = upgrading.search(/^## /m);
    if (firstSection < 0) fail(`${upgradingFile}: no \`## <version>\` section to insert before.`);
    const section = `${heading}\n\n${upgradeEntry(previousAppVersion, appVersion, parseMigrations(migrationsArg))}\n\n`;
    writeFileSync(upgradingFile, upgrading.slice(0, firstSection) + section + upgrading.slice(firstSection));
    console.log(`${upgradingFile}: added a ${heading} section`);
}

emit({
    chart_version: chartVersion,
    previous_chart_version: previousChartVersion,
    previous_app_version: previousAppVersion,
    changed: "true",
});

// --- helpers ----------------------------------------------------------------

function fail(message, code = 1) {
    console.error(message);
    process.exit(code);
}

function parse(version) {
    const m = SEMVER.exec(version);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a, b) {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

// `<app major>.<app minor>.0` when that is ahead of the chart, else the next
// chart patch. 0.2.2 + app 0.3.0 -> 0.3.0; 0.2.2 + app 0.2.1 -> 0.2.3;
// 0.4.1 + app 0.3.2 -> 0.4.2.
function nextChartVersion(current, app) {
    const [major, minor, patch] = parse(current);
    const [appMajor, appMinor] = parse(app);
    const aligned = `${appMajor}.${appMinor}.0`;
    const bumped = `${major}.${minor}.${patch + 1}`;
    return compare(aligned, current) > 0 ? aligned : bumped;
}

// "server/0030_x.sql client/0004_y.sql" -> { server: [...], client: [...] }.
// Names without a prefix are the server's (the common case).
function parseMigrations(text) {
    const out = { server: [], client: [] };
    for (const token of text.split(/\s+/).filter(Boolean)) {
        const slash = token.indexOf("/");
        const side = slash < 0 ? "server" : token.slice(0, slash);
        const file = slash < 0 ? token : token.slice(slash + 1);
        if (!(side in out)) fail(`--migrations: ${token} is neither server/… nor client/…`);
        out[side].push(file);
    }
    return out;
}

// The entry is true of what this script changed: the chart itself is
// untouched, so there is no chart-level breaking change to report. A
// maintainer who adds a chart change to the same release edits it.
function upgradeEntry(from, to, migrations) {
    const total = migrations.server.length + migrations.client.length;
    const lines = [
        "No chart-level breaking change: no value was renamed, removed or given a new",
        "default, so `helm upgrade` with the values you already set is enough.",
        "",
    ];
    let bullet = `\`appVersion\` moves from ${from} to ${to}. `;
    if (total === 0) {
        bullet += "The app release carries no schema migration, so this upgrade rolls back by setting the previous chart version. ";
    } else {
        const sides = [];
        if (migrations.server.length) sides.push(`server ${migrations.server.map((f) => `\`${f}\``).join(", ")}`);
        if (migrations.client.length) sides.push(`client \`auth\` schema ${migrations.client.map((f) => `\`${f}\``).join(", ")}`);
        const count = total === 1 ? "one schema migration" : `${total} schema migrations`;
        bullet += `The app release carries ${count} (${sides.join("; ")}), applied at start-up (\`MIGRATE_ON_START\`). Take a backup first: a migrated database does not roll back by setting the previous chart version. `;
    }
    bullet += `See the [StackRadar ${to} release notes](${RELEASES_URL}/v${to}).`;
    lines.push(...wrap(bullet, "- ", "  ", 78));
    return lines.join("\n");
}

// Word-wrap one paragraph with a first-line prefix and a continuation
// indent, the way the file is written. A Markdown link is one token, so it
// is never split; a token longer than the width gets its own line.
function wrap(text, first, rest, width) {
    const out = [];
    let line = first;
    let prefix = first;
    const words = text.match(/\[[^\]]*\]\([^)]*\)\S*|\S+/g) ?? [];
    for (const word of words) {
        if (line.length > prefix.length && line.length + 1 + word.length > width) {
            out.push(line);
            prefix = rest;
            line = rest + word;
        } else {
            line += (line.length > prefix.length ? " " : "") + word;
        }
    }
    out.push(line);
    return out;
}

function escape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emit(outputs) {
    const text = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    process.stdout.write(text);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
}

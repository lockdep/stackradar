#!/usr/bin/env node
/**
 * Keeps the vendored OSV schema honest against `ossf/osv-schema`.
 *
 *   pnpm osv-schema:check      report drift against upstream main, exit 1 if any
 *   pnpm osv-schema:sync       apply it, then print what changed
 *   pnpm osv-schema:verify     offline: vendored bytes still match the lock
 *
 * We vendor `validation/schema.json` rather than fetching it because
 * `osv.validator.ts` compiles it at process start — a sync worker must not
 * depend on GitHub being reachable, and a schema that changes under us without
 * a commit is a change nobody reviewed.
 *
 * The cost of vendoring is drift, and drift here is quiet: a stale schema does
 * not fail, it just files correct advisories as warnings. That is exactly what
 * happened — upstream added the `CLSA` prefix, our copy did not have it, and
 * 8,104 CleanStart advisories were logged as "parse failures" while being
 * ingested perfectly. `check` is what turns that into a build failure instead
 * of a number nobody trusts.
 *
 * `verify` is the offline half: it catches the vendored file being hand-edited
 * away from the upstream bytes recorded in the lock. Same idea as
 * `skills-lock.json`, and it runs in the test suite where the network cannot.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..');
const SCHEMA = resolve(SERVER, 'src/schemas/osv-specifications/osv.schema.json');
const LOCK = resolve(SERVER, 'src/schemas/osv-specifications/osv.schema.lock.json');

const REPO = 'ossf/osv-schema';
const PATH = 'validation/schema.json';

const WRITE = process.argv.includes('--write');
const VERIFY = process.argv.includes('--verify');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Null when the lock is absent — the first sync has nothing to check against. */
const readLock = () => {
    try {
        return JSON.parse(readFileSync(LOCK, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
};

/* ------------------------------------------------------------- offline --- */

/** Vendored bytes still match what the lock says we pulled. No network. */
function verify() {
    const lock = readLock();
    if (!lock) {
        console.error('✗ osv.schema.lock.json is missing — run `pnpm osv-schema:sync`');
        return 1;
    }
    const actual = sha256(readFileSync(SCHEMA));
    if (actual === lock.sha256) {
        console.log(`✓ osv.schema.json matches lock (${REPO}@${lock.commit.slice(0, 12)})`);
        return 0;
    }
    console.error('✗ osv.schema.json does not match osv.schema.lock.json');
    console.error(`    expected sha256 ${lock.sha256}`);
    console.error(`    actual   sha256 ${actual}`);
    console.error('  The vendored schema was edited by hand. Upstream is the only');
    console.error('  source of truth here — run `pnpm osv-schema:sync` instead.');
    return 1;
}

/* -------------------------------------------------------------- github --- */

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'stackradar-osv-schema-sync',
            ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}`);
    return res.json();
}

/** Latest commit that touched the schema file, so the pin is precise. */
async function latestCommit() {
    const commits = await fetchJson(
        `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(PATH)}&per_page=1`,
    );
    const head = commits[0];
    if (!head?.sha) throw new Error(`No commits found for ${REPO}/${PATH}`);
    return { sha: head.sha, date: head.commit?.committer?.date ?? null };
}

async function fetchSchemaAt(sha) {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${PATH}`, {
        headers: { 'user-agent': 'stackradar-osv-schema-sync' },
    });
    if (!res.ok) throw new Error(`raw.githubusercontent ${res.status} for ${sha}`);
    return Buffer.from(await res.arrayBuffer());
}

/* ---------------------------------------------------------------- diff --- */

/**
 * Alternatives inside the hand-rolled `^(A|B|C)-` patterns upstream uses for
 * ID prefixes and ecosystems. These are where additive upstream changes
 * actually land, and a raw string diff of a 900-character regex tells you
 * nothing, so they get pulled apart and compared as sets.
 */
function alternatives(pattern) {
    if (typeof pattern !== 'string') return null;
    const inner = pattern.match(/\(([^()]*\|[^()]*)\)/);
    return inner ? new Set(inner[1].split('|')) : null;
}

const setDiff = (before, after) => ({
    added: [...after].filter((v) => !before.has(v)),
    removed: [...before].filter((v) => !after.has(v)),
});

/** Every leaf path in a JSON document, as `path -> serialised value`. */
function leaves(node, path = '', out = new Map()) {
    if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) leaves(value, `${path}/${key}`, out);
    } else {
        out.set(path, JSON.stringify(node));
    }
    return out;
}

function summarise(beforeRaw, afterRaw) {
    const before = JSON.parse(beforeRaw.toString('utf8'));
    const after = JSON.parse(afterRaw.toString('utf8'));
    const lines = [];

    const named = [
        ['ID prefixes', before.$defs?.prefix?.pattern, after.$defs?.prefix?.pattern],
        ['ecosystems', before.$defs?.ecosystemWithSuffix?.pattern, after.$defs?.ecosystemWithSuffix?.pattern],
    ];
    for (const [label, b, a] of named) {
        const bs = alternatives(b);
        const as = alternatives(a);
        if (!bs || !as) continue;
        const { added, removed } = setDiff(bs, as);
        if (added.length) lines.push(`  + ${label}: ${added.join(', ')}`);
        if (removed.length) lines.push(`  - ${label}: ${removed.join(', ')}`);
    }

    const bEco = new Set(before.$defs?.ecosystemName?.enum ?? []);
    const aEco = new Set(after.$defs?.ecosystemName?.enum ?? []);
    const eco = setDiff(bEco, aEco);
    if (eco.added.length) lines.push(`  + ecosystemName enum: ${eco.added.join(', ')}`);
    if (eco.removed.length) lines.push(`  - ecosystemName enum: ${eco.removed.join(', ')}`);

    // Everything else, as leaf paths. Titles are the useful signal here —
    // upstream names each new conditional rule, e.g. "GIT ranges must use
    // full-length commit hashes", which is how a new *constraint* announces
    // itself rather than showing up as an unreadable pattern change.
    const bl = leaves(before);
    const al = leaves(after);
    const structural = [];
    const clip = (v) => (v.length > 90 ? `${v.slice(0, 90)}…` : v);
    for (const [path, value] of al) {
        if (!bl.has(path)) structural.push(`  + ${path} = ${clip(value)}`);
        else if (bl.get(path) !== value) structural.push(`  ~ ${path} → ${clip(value)}`);
    }
    for (const path of bl.keys()) if (!al.has(path)) structural.push(`  - ${path}`);

    const titles = structural.filter((l) => l.includes('/title'));
    const rest = structural.filter((l) => !l.includes('/title'));
    lines.push(...titles);
    lines.push(...rest.slice(0, 15));
    if (rest.length > 15) lines.push(`  … and ${rest.length - 15} more structural changes`);

    return lines;
}

/* --------------------------------------------------------------- main ---- */

async function main() {
    if (VERIFY) return verify();

    const lock = readLock();
    const vendored = readFileSync(SCHEMA);
    const vendoredHash = sha256(vendored);

    if (lock && vendoredHash !== lock.sha256) {
        console.error('✗ Vendored schema does not match the lock — resolve that first:');
        console.error('    pnpm osv-schema:verify');
        return 1;
    }

    const { sha, date } = await latestCommit();
    const upstream = await fetchSchemaAt(sha);
    const upstreamHash = sha256(upstream);

    if (upstreamHash === vendoredHash) {
        console.log(`✓ osv.schema.json is up to date with ${REPO}@${sha.slice(0, 12)}`);
        if (sha !== lock?.commit && WRITE) {
            // Content identical, pin moved: record the newer commit so the next
            // check does not re-download for a change that was not ours.
            writeLock({ sha, date, hash: upstreamHash });
            console.log(`  pin advanced to ${sha.slice(0, 12)} (content unchanged)`);
        }
        return 0;
    }

    console.log(`osv.schema.json differs from ${REPO}@${sha.slice(0, 12)}${date ? ` (${date})` : ''}`);
    const summary = summarise(vendored, upstream);
    console.log(summary.length ? summary.join('\n') : '  (no structural summary available)');
    console.log();

    if (!WRITE) {
        console.error('Run `pnpm osv-schema:sync` to vendor the upstream copy.');
        console.error('Note: new upstream constraints can raise the validation-warning');
        console.error('count. Those are warnings — records are still ingested.');
        return 1;
    }

    writeFileSync(SCHEMA, upstream);
    writeLock({ sha, date, hash: upstreamHash });
    console.log(`✓ Vendored ${REPO}@${sha.slice(0, 12)} into osv.schema.json`);
    return 0;
}

function writeLock({ sha, date, hash }) {
    const lock = {
        $comment: 'Generated by scripts/sync-osv-schema.mjs — do not edit by hand.',
        repo: REPO,
        path: PATH,
        commit: sha,
        commitDate: date,
        sha256: hash,
        syncedAt: new Date().toISOString(),
    };
    writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(`osv-schema sync failed: ${error.message}`);
        process.exit(2);
    });

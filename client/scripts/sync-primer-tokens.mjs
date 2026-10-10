#!/usr/bin/env node
/**
 * Keeps LAYER 1 of `src/app/theme.css` honest against `@primer/primitives`.
 *
 *   pnpm tokens:check          report drift, exit 1 if any unpinned primitive differs
 *   pnpm tokens:sync           apply it, then print what changed
 *   pnpm tokens:find danger    search Primer's tokens by name/description
 *
 * `@primer/primitives` is a devDependency: we read its token files at build
 * time and write the ~50 values we use into theme.css. We deliberately do not
 * import its CSS at runtime — each theme file declares ~1,900 custom properties
 * (~120 KB), and we use about 2% of them.
 *
 * The script also fails when a mapped Primer token disappears, which is how a
 * `pnpm up @primer/primitives` that renames something gets caught here rather
 * than in a screenshot three weeks later.
 *
 * It also asserts BRAND_LITERALS — the handful of raw hex strings in
 * `src/lib/brand.ts` that the app-icon routes need because Satori cannot
 * resolve CSS custom properties. Ported from the landing page's copy of this
 * script, where the same assertion guards the OG image.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TOKEN_MAP, THEME_ONLY, BRAND_LITERALS, BRAND_THEME } from './primer-token-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, '..');
const THEME_CSS = resolve(CLIENT, 'src/app/theme.css');
const BRAND_TS = resolve(CLIENT, 'src/lib/brand.ts');
const PRIMITIVES = resolve(CLIENT, 'node_modules/@primer/primitives');

const THEMES = ['light', 'dark'];
const PREFIX = { light: '--primer-l-', dark: '--primer-d-' };

const WRITE = process.argv.includes('--write');
const FIND = process.argv.includes('--find') ? process.argv[process.argv.indexOf('--find') + 1] : null;

/* ---------------------------------------------------------------- Primer --- */

/** Parse one Primer theme file into a flat map, resolving `var()` chains. */
function loadPrimerTheme(theme) {
    const css = readFileSync(resolve(PRIMITIVES, `dist/css/functional/themes/${theme}.css`), 'utf8');
    const raw = new Map();
    for (const [, name, value] of css.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) {
        raw.set(name, value.trim());
    }

    const resolved = new Map();
    const resolveToken = (name, seen = new Set()) => {
        if (resolved.has(name)) return resolved.get(name);
        if (seen.has(name)) throw new Error(`Circular var() chain at --${name} in Primer ${theme}`);
        seen.add(name);

        const value = raw.get(name);
        if (value === undefined) return undefined;

        const ref = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
        const out = ref ? resolveToken(ref[1], seen) : value;
        resolved.set(name, out);
        return out;
    };

    for (const name of raw.keys()) resolveToken(name);
    return resolved;
}

const primerVersion = JSON.parse(readFileSync(resolve(PRIMITIVES, 'package.json'), 'utf8')).version;
const primer = Object.fromEntries(THEMES.map((t) => [t, loadPrimerTheme(t)]));

/* ------------------------------------------------------------------- Find --- */

/**
 * `--find` — what to reach for when adding a colour. Searches token names and
 * Primer's own one-line descriptions, and prints both resolved theme values so
 * you can see whether the token actually behaves in dark.
 */
if (FIND) {
    const docs = new Map();
    for (const theme of THEMES) {
        const css = readFileSync(resolve(PRIMITIVES, `dist/css/functional/themes/${theme}.css`), 'utf8');
        for (const [, name, , desc] of css.matchAll(/^\s*--([\w-]+):\s*([^;]+);(?:\s*\/\*\*\s*(.*?)\s*\*\/)?/gm)) {
            if (desc && !docs.has(name)) docs.set(name, desc);
        }
    }

    const q = FIND.toLowerCase();
    const hits = [...primer.light.keys()]
        .filter((n) => n.toLowerCase().includes(q) || (docs.get(n) ?? '').toLowerCase().includes(q))
        .sort();

    const used = new Map();
    for (const [name, entry] of Object.entries(TOKEN_MAP)) {
        if (!entry.primer) continue;
        for (const t of typeof entry.primer === 'string' ? [entry.primer] : Object.values(entry.primer)) {
            used.set(t, name);
        }
    }

    console.log(`\n${hits.length} token(s) matching "${FIND}" in @primer/primitives@${primerVersion}\n`);
    for (const n of hits) {
        const mine = used.get(n);
        console.log(`  --${n}`);
        console.log(`      light ${primer.light.get(n) ?? '—'}   dark ${primer.dark.get(n) ?? '—'}`);
        if (docs.get(n)) console.log(`      ${docs.get(n)}`);
        if (mine) console.log(`      ALREADY OURS → --primer-{l,d}-${mine}`);
    }
    console.log();
    process.exit(0);
}

/* ------------------------------------------------------------- Colour eq --- */

/** Canonical `r,g,b,a` so `rgba(84, 174, 255, 0.4)` and `#54aeff66` compare equal. */
function normalise(value) {
    const v = value.trim().toLowerCase();

    const hex = v.match(/^#([0-9a-f]{3,8})$/);
    if (hex) {
        let h = hex[1];
        if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return `${r},${g},${b},${a.toFixed(3)}`;
    }

    const fn = v.match(/^rgba?\(([^)]+)\)$/);
    if (fn) {
        const parts = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        const [r, g, b] = parts;
        const a = parts.length > 3 ? parts[3] : 1;
        return `${r},${g},${b},${a.toFixed(3)}`;
    }

    return v;
}

const sameColour = (a, b) => normalise(a) === normalise(b);

/* -------------------------------------------------------------- theme.css --- */

const themeCss = readFileSync(THEME_CSS, 'utf8');

/** Every `--primer-{l,d}-*` declaration currently in the file. */
function readOurPrimitives() {
    const out = { light: new Map(), dark: new Map() };
    for (const [, prefix, name, value] of themeCss.matchAll(/^\s*--primer-([ld])-([\w-]+):\s*([^;]+);/gm)) {
        out[prefix === 'l' ? 'light' : 'dark'].set(name, value.trim());
    }
    return out;
}

const ours = readOurPrimitives();

/* ---------------------------------------------------------------- Compare --- */

const problems = [];
const drift = [];
const pinned = [];

// Mapping and file must describe the same set of primitives.
for (const theme of THEMES) {
    const expected = Object.keys(TOKEN_MAP).filter(
        (k) => !Object.entries(THEME_ONLY).some(([t, names]) => t !== theme && names.includes(k)),
    );

    for (const name of ours[theme].keys()) {
        if (!TOKEN_MAP[name]) {
            problems.push(`${PREFIX[theme]}${name} has no entry in scripts/primer-token-map.mjs`);
        }
    }
    for (const name of expected) {
        if (!ours[theme].has(name)) {
            problems.push(`${PREFIX[theme]}${name} is mapped but missing from theme.css`);
        }
    }
}

for (const [name, entry] of Object.entries(TOKEN_MAP)) {
    if (entry.local) continue;

    for (const theme of THEMES) {
        const current = ours[theme].get(name);
        if (current === undefined) continue;

        const token = typeof entry.primer === 'string' ? entry.primer : entry.primer[theme];
        const upstream = primer[theme].get(token);

        if (upstream === undefined) {
            problems.push(
                `${PREFIX[theme]}${name} maps to --${token}, which @primer/primitives@${primerVersion} ` +
                    `no longer publishes for ${theme}. Re-map it or mark it local.`,
            );
            continue;
        }

        if (sameColour(current, upstream)) continue;

        const record = { theme, name, token, current, upstream, reason: entry.pin?.[theme] };
        (record.reason ? pinned : drift).push(record);
    }
}

/* ------------------------------------------------------------------ brand.ts --- */

/**
 * The app-icon routes cannot read CSS custom properties, so `src/lib/brand.ts`
 * restates a few colours as literals. Assert each one still equals the
 * `BRAND_THEME` primitive it was copied from — checked against theme.css rather than Primer,
 * so a pinned divergence stays consistent end to end.
 */
const brandTs = readFileSync(BRAND_TS, 'utf8');
const brandLiterals = new Map();
for (const [, name, value] of brandTs.matchAll(/^export const ([A-Z_]+)\s*=\s*'([^']+)'/gm)) {
    brandLiterals.set(name, value);
}

for (const [constName, primitive] of Object.entries(BRAND_LITERALS)) {
    const literal = brandLiterals.get(constName);
    const expected = ours[BRAND_THEME].get(primitive);

    if (literal === undefined) {
        problems.push(`src/lib/brand.ts does not export ${constName}, which BRAND_LITERALS maps to ${PREFIX[BRAND_THEME]}${primitive}`);
        continue;
    }
    if (expected === undefined) {
        problems.push(`BRAND_LITERALS maps ${constName} to ${PREFIX[BRAND_THEME]}${primitive}, which theme.css does not declare`);
        continue;
    }
    if (!sameColour(literal, expected)) {
        problems.push(
            `src/lib/brand.ts ${constName} is ${literal}, but ${PREFIX[BRAND_THEME]}${primitive} is ${expected}. ` +
                `The app icon would render off-palette — update brand.ts.`,
        );
    }
}

for (const name of brandLiterals.keys()) {
    if (!(name in BRAND_LITERALS) && /^#/.test(brandLiterals.get(name))) {
        problems.push(
            `src/lib/brand.ts exports ${name} as a raw colour with no entry in BRAND_LITERALS. ` +
                `Map it to a primitive, or move it to the documented-exception list.`,
        );
    }
}

/* ------------------------------------------------------------------ Write --- */

let updated = themeCss;

if (WRITE && drift.length) {
    for (const { theme, name, upstream } of drift) {
        const decl = new RegExp(`(^\\s*${PREFIX[theme]}${name}:\\s*)([^;]+)(;)`, 'm');
        updated = updated.replace(decl, `$1${upstream}$3`);
    }
}

// The header records which Primer release LAYER 1 was last reconciled against.
const stamp = `Synced from @primer/primitives@${primerVersion} — see scripts/sync-primer-tokens.mjs`;
const stampLine = /Synced from @primer\/primitives@[^\s]+ — see scripts\/sync-primer-tokens\.mjs/;
if (WRITE) {
    if (stampLine.test(updated)) updated = updated.replace(stampLine, stamp);
    else problems.push('theme.css header is missing the "Synced from @primer/primitives@…" line');
}

if (WRITE && updated !== themeCss) writeFileSync(THEME_CSS, updated);

/* ----------------------------------------------------------------- Report --- */

const pad = (s, n) => String(s).padEnd(n);

function table(rows) {
    const w = {
        tok: Math.max(...rows.map((r) => PREFIX[r.theme].length + r.name.length)),
        cur: Math.max(...rows.map((r) => r.current.length)),
    };
    for (const r of rows) {
        console.log(
            `  ${pad(PREFIX[r.theme] + r.name, w.tok)}  ${pad(r.current, w.cur)} → ${pad(r.upstream, w.cur)}  (--${r.token})`,
        );
    }
}

console.log(`\n@primer/primitives@${primerVersion} vs src/app/theme.css LAYER 1\n`);

if (pinned.length) {
    console.log(`${pinned.length} pinned — divergent on purpose, not synced:`);
    table(pinned);
    for (const p of pinned) {
        console.log(`\n  ${PREFIX[p.theme]}${p.name}:\n      ${p.reason.replace(/\s+/g, ' ').trim()}`);
    }
    console.log();
}

if (problems.length) {
    console.error(`${problems.length} mapping problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error();
}

if (drift.length) {
    console.log(`${drift.length} ${WRITE ? 'updated' : 'drifted'}:`);
    table(drift);
    console.log();
    if (!WRITE) console.log('Run `pnpm tokens:sync` to apply, or add a `pin` in scripts/primer-token-map.mjs.\n');
} else if (!problems.length) {
    console.log('In sync.\n');
}

process.exit(problems.length || (!WRITE && drift.length) ? 1 : 0);

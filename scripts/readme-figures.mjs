#!/usr/bin/env node
/**
 * README figures.
 *
 * Writes the SVG illustrations under docs/images/ that the README's
 * "How it works" section embeds: the system topology (who talks to whom,
 * over which boundary) and the life of one image (discover, SBOM, match,
 * score, fix, and where each step runs). Each comes in a light and a dark
 * variant so a <picture> element can follow the viewer's GitHub theme.
 *
 * The colours are the Primer primitives that `client/src/app/theme.css` is
 * generated from, so the figures sit next to the dashboard screenshot
 * without a seam. The fonts are the system stack GitHub renders markdown
 * with: an SVG inside an <img> loads no web fonts, so every text box below
 * leaves slack for the widest common rendering.
 *
 * No dependencies; runs on bare node from a bare checkout:
 *
 *   node scripts/readme-figures.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "images");

// ---------------------------------------------------------------------------
// Palette: Primer light / dark primitives (see client/src/app/theme.css).
// ---------------------------------------------------------------------------

const THEMES = {
    light: {
        canvas: "#ffffff",
        subtle: "#f6f8fa",
        border: "#d1d9e0",
        fg: "#1f2328",
        muted: "#59636e",
        faint: "#818b98",
        accent: "#0969da",
        emphasis: "#0969da",
        boxFill: "#ddf4ff",
        boxStroke: "#0969da",
        accentSubtle: "#ddf4ff",
        onAccent: "#ffffff",
        critical: "#d1242f",
        high: "#bc4c00",
        medium: "#9a6700",
        low: "#59636e",
    },
    dark: {
        canvas: "#0d1117",
        subtle: "#161b22",
        border: "#3d444d",
        fg: "#f0f6fc",
        muted: "#9198a1",
        faint: "#656c76",
        accent: "#4493f8",
        emphasis: "#1f6feb",
        boxFill: "#0c2d6b",
        boxStroke: "#4493f8",
        accentSubtle: "rgba(56, 139, 253, 0.15)",
        onAccent: "#ffffff",
        critical: "#f85149",
        high: "#db6d28",
        medium: "#d29922",
        low: "#9198a1",
    },
};

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;

// ---------------------------------------------------------------------------
// Primitives. Every helper returns an SVG fragment as a string.
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rough advance width of a string, used only to size pills and chips. */
const measure = (s, size, mono = false) => s.length * size * (mono ? 0.62 : 0.56);

function text(x, y, s, o = {}) {
    const { size = 12, weight = 400, fill, anchor = "start", mono = false } = o;
    const family = mono ? MONO : FONT;
    return `<text x="${x}" y="${y}" font-family='${family}' font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

function rect(x, y, w, h, o = {}) {
    const { rx = 8, fill = "none", stroke = "none", sw = 1, dash = "" } = o;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function line(d, o = {}) {
    const { stroke, sw = 1.5, dash = "", marker = "" } = o;
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}${marker ? ` marker-end="url(#${marker})"` : ""}/>`;
}

/** One arrowhead marker per colour: SVG 1.1 markers do not inherit stroke. */
function marker(id, fill) {
    return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 Z" fill="${fill}"/></marker>`;
}

/** A chip of sample data, left-aligned; returns [svg, width]. */
function chip(x, y, s, t, o = {}) {
    const { size = 9.5, mono = true } = o;
    const w = Math.ceil(measure(s, size, mono)) + 12;
    const h = 20;
    const svg =
        rect(x, y, w, h, { rx: 5, fill: t.subtle, stroke: t.border }) +
        text(x + w / 2, y + h / 2 + size * 0.36, s, { size, fill: t.muted, anchor: "middle", mono });
    return [svg, w];
}

// ---------------------------------------------------------------------------
// Glyphs, each drawn in a 20×20 box whose top-left is (x, y).
// ---------------------------------------------------------------------------

const glyph = {
    ring: (x, y, c) => `<circle cx="${x + 10}" cy="${y + 10}" r="7" fill="none" stroke="${c}" stroke-width="4"/>`,
    browser: (x, y, c) =>
        rect(x + 1.5, y + 3, 17, 14, { rx: 2.5, stroke: c, sw: 1.5 }) +
        line(`M${x + 1.5} ${y + 7.5} H${x + 18.5}`, { stroke: c }) +
        `<circle cx="${x + 4.5}" cy="${y + 5.25}" r="0.9" fill="${c}"/><circle cx="${x + 7.5}" cy="${y + 5.25}" r="0.9" fill="${c}"/>`,
    cluster: (x, y, c) =>
        rect(x + 2, y + 3, 16, 6, { rx: 1.5, stroke: c, sw: 1.5 }) +
        rect(x + 2, y + 11, 16, 6, { rx: 1.5, stroke: c, sw: 1.5 }) +
        `<circle cx="${x + 5}" cy="${y + 6}" r="1" fill="${c}"/><circle cx="${x + 5}" cy="${y + 14}" r="1" fill="${c}"/>`,
    pods: (x, y, c) =>
        line(`M${x + 10} ${y + 2} L${x + 17} ${y + 6} V${y + 14} L${x + 10} ${y + 18} L${x + 3} ${y + 14} V${y + 6} Z M${x + 3} ${y + 6} L${x + 10} ${y + 10} L${x + 17} ${y + 6} M${x + 10} ${y + 10} V${y + 18}`, { stroke: c }),
    scan: (x, y, c) =>
        line(`M${x + 2} ${y + 7} V${y + 4} a2 2 0 0 1 2 -2 H${x + 7} M${x + 13} ${y + 2} H${x + 16} a2 2 0 0 1 2 2 V${y + 7} M${x + 18} ${y + 13} V${y + 16} a2 2 0 0 1 -2 2 H${x + 13} M${x + 7} ${y + 18} H${x + 4} a2 2 0 0 1 -2 -2 V${y + 13} M${x + 5} ${y + 10} H${x + 15}`, { stroke: c }),
    database: (x, y, c) =>
        `<ellipse cx="${x + 10}" cy="${y + 5}" rx="7" ry="3" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 3} ${y + 5} V${y + 15} a7 3 0 0 0 14 0 V${y + 5} M${x + 3} ${y + 10} a7 3 0 0 0 14 0`, { stroke: c }),
    globe: (x, y, c) =>
        `<circle cx="${x + 10}" cy="${y + 10}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 2.5} ${y + 10} H${x + 17.5} M${x + 10} ${y + 2.5} a11 11 0 0 1 0 15 M${x + 10} ${y + 2.5} a11 11 0 0 0 0 15`, { stroke: c, sw: 1.25 }),
    search: (x, y, c) =>
        `<circle cx="${x + 8.5}" cy="${y + 8.5}" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 12.5} ${y + 12.5} L${x + 17.5} ${y + 17.5}`, { stroke: c }),
    gauge: (x, y, c) =>
        line(`M${x + 3} ${y + 15} a7.5 7.5 0 0 1 14 0 M${x + 10} ${y + 14} L${x + 13.5} ${y + 8}`, { stroke: c }) +
        `<circle cx="${x + 10}" cy="${y + 14}" r="1.5" fill="${c}"/>`,
    shield: (x, y, c) =>
        line(`M${x + 10} ${y + 2} L${x + 17} ${y + 5} V${y + 10} c0 4.5 -3 7 -7 8 c-4 -1 -7 -3.5 -7 -8 V${y + 5} Z M${x + 7} ${y + 10} L${x + 9.5} ${y + 12.5} L${x + 13.5} ${y + 7.5}`, { stroke: c }),
    upgrade: (x, y, c) =>
        `<circle cx="${x + 10}" cy="${y + 10}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 10} ${y + 14} V${y + 6} M${x + 6.5} ${y + 9.5} L${x + 10} ${y + 6} L${x + 13.5} ${y + 9.5}`, { stroke: c }),
};

function svg(w, h, t, body, label) {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">\n` +
        `<defs>${marker("arrow-muted", t.muted)}${marker("arrow-accent", t.accent)}${marker("arrow-faint", t.faint)}${marker("arrow-fg", t.fg)}</defs>\n` +
        body +
        `\n</svg>\n`
    );
}

// ---------------------------------------------------------------------------
// Figure 1: the topology.
//
// Flat and iconic: tinted boxes for places, solid tiles for components, a
// dashed border for the cluster, short bold labels and plain arrows. What a
// component does is the README's job, not the figure's.
// ---------------------------------------------------------------------------

const TILE = 56;

/** A solid accent tile with a white glyph, and its label underneath. */
function tile(cx, cy, g, label, t) {
    const x = cx - TILE / 2;
    const y = cy - TILE / 2;
    return (
        rect(x, y, TILE, TILE, { rx: 10, fill: t.emphasis }) +
        `<g transform="translate(${cx - 16} ${cy - 16}) scale(1.6)">${g(0, 0, t.onAccent)}</g>` +
        text(cx, y + TILE + 22, label, { size: 15, weight: 700, fill: t.fg, anchor: "middle" })
    );
}

/** A solid accent database cylinder, the same height as a tile. */
function cylinder(cx, cy, label, t) {
    const w = 48;
    const h = TILE;
    const ry = 8;
    const x = cx - w / 2;
    const y = cy - h / 2;
    return (
        `<path d="M${x} ${y + ry} V${y + h - ry} a${w / 2} ${ry} 0 0 0 ${w} 0 V${y + ry} Z" fill="${t.emphasis}"/>` +
        `<ellipse cx="${cx}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${t.emphasis}"/>` +
        `<ellipse cx="${cx}" cy="${y + ry}" rx="${w / 2 - 5}" ry="${ry - 3.5}" fill="none" stroke="${t.onAccent}" stroke-width="1.5"/>` +
        line(`M${x + 5} ${y + 24} a${w / 2 - 5} ${ry - 3.5} 0 0 0 ${w - 10} 0 M${x + 5} ${y + 38} a${w / 2 - 5} ${ry - 3.5} 0 0 0 ${w - 10} 0`, { stroke: t.onAccent }) +
        text(cx, y + h + 22, label, { size: 15, weight: 700, fill: t.fg, anchor: "middle" })
    );
}

/** A stack of three pods, back to front. */
function podStack(cx, cy, t) {
    let s = "";
    [-12, 0, 12].forEach((d, i, all) => {
        const x = cx - 20 + d;
        const y = cy - 20 + d;
        s += rect(x, y, 40, 40, { rx: 8, fill: t.emphasis, stroke: t.boxFill, sw: 3 });
        if (i === all.length - 1) s += `<g transform="translate(${x + 8} ${y + 8}) scale(1.2)">${glyph.pods(0, 0, t.onAccent)}</g>`;
    });
    return s;
}

/** A tinted place: pale box with an accent border and a bold title. */
function place(x, y, w, h, title, t) {
    return rect(x, y, w, h, { rx: 6, fill: t.boxFill, stroke: t.boxStroke, sw: 1.5 }) + text(x + w / 2, y + 26, title, { size: 15, weight: 700, fill: t.fg, anchor: "middle" });
}

function topology(t) {
    const W = 920;
    const H = 580;
    const arrow = (d) => line(d, { stroke: t.fg, sw: 1.75, marker: "arrow-fg" });
    let s = "";

    // The cluster is a dashed boundary; everything StackRadar needs is inside it.
    const CX = 200;
    const CY = 150;
    const CW = 680;
    const CH = 410;
    s += rect(CX, CY, CW, CH, { rx: 0, fill: "none", stroke: t.fg, sw: 1.5, dash: "6 5" });
    s += text(CX + 16, CY + 24, "Your Kubernetes cluster", { size: 15, weight: 700, fill: t.fg });

    // StackRadar: client, server and the database, in one place.
    const SX = 430;
    const SY = 180;
    const SW = 420;
    const SH = 150;
    const rowY = SY + 70;
    const clientX = SX + 70;
    const serverX = SX + SW / 2;
    const pgX = SX + SW - 70;
    s += place(SX, SY, SW, SH, "StackRadar", t);
    s += tile(clientX, rowY, glyph.browser, "Client", t);
    s += tile(serverX, rowY, glyph.ring, "Server", t);
    s += cylinder(pgX, rowY, "PostgreSQL", t);
    s += arrow(`M${clientX + TILE / 2 + 6} ${rowY} H${serverX - TILE / 2 - 8}`);
    s += arrow(`M${serverX + TILE / 2 + 6} ${rowY} H${pgX - 24 - 8}`);

    // The browser, outside, reaches the client only.
    s += place(24, rowY - 28, 130, 56, "", t);
    s += text(89, rowY + 5.5, "Browser", { size: 15, weight: 700, fill: t.fg, anchor: "middle" });
    s += arrow(`M154 ${rowY} H${clientX - TILE / 2 - 8}`);

    // The pods, and the scanner that watches them and reports to the server.
    const PX = 230;
    const PY = 380;
    const PW = 160;
    const PH = 160;
    s += place(PX, PY, PW, PH, "Pods", t);
    s += podStack(PX + PW / 2, PY + 96, t);
    const scanY = PY + 80;
    s += tile(serverX, scanY, glyph.scan, "Scanner", t);
    s += arrow(`M${PX + PW} ${scanY} H${serverX - TILE / 2 - 8}`);
    s += arrow(`M${serverX} ${scanY - TILE / 2} V${SY + SH + 8}`);

    // The advisory feeds, outside: the server pulls them, nothing is sent.
    const feeds = [
        ["OSV.dev", glyph.globe],
        ["EPSS", glyph.gauge],
        ["CISA KEV", glyph.shield],
    ];
    const feedY = 48;
    const busY = 130;
    feeds.forEach(([label, g], i) => {
        const x = serverX + (i - 1) * 150;
        s += tile(x, feedY, g, label, t);
        s += line(`M${x} ${feedY + TILE / 2 + 32} V${busY}`, { stroke: t.fg, sw: 1.75 });
    });
    s += line(`M${serverX - 150} ${busY} H${serverX + 150}`, { stroke: t.fg, sw: 1.75 });
    s += arrow(`M${serverX} ${busY} V${SY - 8}`);

    return svg(
        W,
        H,
        t,
        s,
        "StackRadar topology in a self-hosted install: the scanner, the client, the server and PostgreSQL all run in your Kubernetes cluster. The scanner watches the pods and reports to the server; the browser reaches the client only; the server pulls OSV.dev, EPSS and CISA KEV, the only traffic that crosses the cluster boundary.",
    );
}

// ---------------------------------------------------------------------------
// Figure 2: the life of one image.
// ---------------------------------------------------------------------------

function pipeline(t) {
    const W = 960;
    const H = 246;
    const X0 = 12;
    const CW = 168;
    const GAP = 24;
    const CY = 20;
    const CH = 164;
    let s = "";

    const sevBar = (x, y) => {
        const parts = [
            [24, t.critical],
            [50, t.high],
            [46, t.medium],
            [24, t.low],
        ];
        let out = `<clipPath id="sev"><rect x="${x}" y="${y}" width="144" height="10" rx="5"/></clipPath><g clip-path="url(#sev)">`;
        let cx = x;
        for (const [w, c] of parts) {
            out += `<rect x="${cx}" y="${y}" width="${w - 2}" height="10" fill="${c}"/>`;
            cx += w;
        }
        return out + "</g>";
    };

    const steps = [
        {
            title: "Discover",
            icon: glyph.scan,
            lines: ["The agent watches every", "pod in the cluster. Read-", "only: list and watch,", "nothing else."],
            footer: (x, y) => {
                let out = "";
                let cx = x;
                for (const ns of ["ci", "argocd", "grafana"]) {
                    const [c, w] = chip(cx, y, ns, t);
                    out += c;
                    cx += w + 6;
                }
                return out;
            },
        },
        {
            title: "SBOM",
            icon: glyph.pods,
            lines: ["Pulled once per digest.", "Syft writes a CycloneDX", "SBOM; the inventory says", "where the image runs."],
            footer: (x, y) => chip(x, y, "pkg:npm/express@4.19.2", t)[0],
        },
        {
            title: "Match",
            icon: glyph.search,
            lines: ["Each package URL is", "looked up in the local", "OSV.dev mirror, and again", "whenever it changes."],
            footer: (x, y) => chip(x, y, "CVE-2025-1974", t)[0],
        },
        {
            title: "Score",
            icon: glyph.gauge,
            lines: ["CVSS, EPSS and KEV fold", "into one number per", "finding; sums rank images,", "containers and clusters."],
            footer: (x, y) => sevBar(x, y + 5),
        },
        {
            title: "Fix",
            icon: glyph.upgrade,
            lines: ["The tag or chart version", "to move to, what that", "removes, and the command", "that does it."],
            footer: (x, y) => chip(x, y, "argocd app sync jenkins", t)[0],
        },
    ];

    steps.forEach((step, i) => {
        const x = X0 + i * (CW + GAP);
        s += rect(x, CY, CW, CH, { fill: t.canvas, stroke: t.border });
        // number badge
        s += `<circle cx="${x + 25}" cy="${CY + 25}" r="11" fill="${t.accent}"/>`;
        s += text(x + 25, CY + 29, String(i + 1), { size: 11, weight: 600, fill: t.onAccent, anchor: "middle" });
        s += text(x + 44, CY + 29.5, step.title, { size: 13, weight: 600, fill: t.fg });
        s += step.icon(x + CW - 34, CY + 15, t.faint);
        step.lines.forEach((l, j) => {
            s += text(x + 14, CY + 58 + j * 15, l, { size: 10.5, fill: t.muted });
        });
        s += step.footer(x + 14, CY + 126);
        if (i < steps.length - 1) {
            s += line(`M${x + CW + 4} ${CY + 25} H${x + CW + GAP - 6}`, { stroke: t.muted, marker: "arrow-muted" });
        }
    });

    // Where each step runs.
    const bracket = (x1, x2, label) => {
        const y = CY + CH + 22;
        return (
            line(`M${x1} ${y - 6} V${y} H${x2} V${y - 6}`, { stroke: t.border, sw: 1 }) +
            text((x1 + x2) / 2, y + 20, label, { size: 11, weight: 600, fill: t.muted, anchor: "middle" })
        );
    };
    s += bracket(X0, X0 + 2 * CW + GAP, "In your cluster · stackradar-scanner");
    s += bracket(X0 + 2 * (CW + GAP), X0 + 5 * CW + 4 * GAP, "On the server · this repository");

    return svg(
        W,
        H,
        t,
        s,
        "The life of one image: discovered by the read-only agent, inventoried and turned into a CycloneDX SBOM once per digest in your cluster; then matched against the local OSV.dev mirror, scored with CVSS, EPSS and KEV, and given a concrete fix on the server.",
    );
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
    writeFileSync(join(OUT, `how-it-works-${name}.svg`), topology(t));
    writeFileSync(join(OUT, `one-image-${name}.svg`), pipeline(t));
}
console.log(`wrote 4 figures to ${OUT}`);

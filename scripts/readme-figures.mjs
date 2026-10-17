#!/usr/bin/env node
/**
 * README figure.
 *
 * Writes the SVG illustration under docs/images/ that the README's
 * "How it works" section embeds: the self-hosted topology, who runs where
 * and which three lines cross the cluster boundary. It comes in a light
 * and a dark variant so a <picture> element can follow the viewer's
 * GitHub theme.
 *
 * The colours are the Primer primitives that `client/src/app/theme.css` is
 * generated from, so the figure sits next to the dashboard screenshot
 * without a seam. The fonts are the system stack GitHub renders markdown
 * with: an SVG inside an <img> loads no web fonts, so every label below
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
        fg: "#1f2328",
        onAccent: "#ffffff",
        emphasis: "#0969da",
        boxFill: "#ddf4ff",
        boxStroke: "#0969da",
    },
    dark: {
        fg: "#f0f6fc",
        onAccent: "#ffffff",
        emphasis: "#1f6feb",
        boxFill: "#0c2d6b",
        boxStroke: "#4493f8",
    },
};

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;

// ---------------------------------------------------------------------------
// Primitives. Every helper returns an SVG fragment as a string.
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function text(x, y, s, o = {}) {
    const { size = 12, weight = 400, fill, anchor = "start" } = o;
    return `<text x="${x}" y="${y}" font-family='${FONT}' font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
}

function rect(x, y, w, h, o = {}) {
    const { rx = 8, fill = "none", stroke = "none", sw = 1, dash = "" } = o;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function line(d, o = {}) {
    const { stroke, sw = 1.5, dash = "", marker = "" } = o;
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}${marker ? ` marker-end="url(#${marker})"` : ""}/>`;
}

/** The arrowhead: SVG 1.1 markers do not inherit stroke, so it carries its own fill. */
function marker(id, fill) {
    return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 Z" fill="${fill}"/></marker>`;
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
    pods: (x, y, c) =>
        line(`M${x + 10} ${y + 2} L${x + 17} ${y + 6} V${y + 14} L${x + 10} ${y + 18} L${x + 3} ${y + 14} V${y + 6} Z M${x + 3} ${y + 6} L${x + 10} ${y + 10} L${x + 17} ${y + 6} M${x + 10} ${y + 10} V${y + 18}`, { stroke: c }),
    scan: (x, y, c) =>
        line(`M${x + 2} ${y + 7} V${y + 4} a2 2 0 0 1 2 -2 H${x + 7} M${x + 13} ${y + 2} H${x + 16} a2 2 0 0 1 2 2 V${y + 7} M${x + 18} ${y + 13} V${y + 16} a2 2 0 0 1 -2 2 H${x + 13} M${x + 7} ${y + 18} H${x + 4} a2 2 0 0 1 -2 -2 V${y + 13} M${x + 5} ${y + 10} H${x + 15}`, { stroke: c }),
    globe: (x, y, c) =>
        `<circle cx="${x + 10}" cy="${y + 10}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5"/>` +
        line(`M${x + 2.5} ${y + 10} H${x + 17.5} M${x + 10} ${y + 2.5} a11 11 0 0 1 0 15 M${x + 10} ${y + 2.5} a11 11 0 0 0 0 15`, { stroke: c, sw: 1.25 }),
    gauge: (x, y, c) =>
        line(`M${x + 3} ${y + 15} a7.5 7.5 0 0 1 14 0 M${x + 10} ${y + 14} L${x + 13.5} ${y + 8}`, { stroke: c }) +
        `<circle cx="${x + 10}" cy="${y + 14}" r="1.5" fill="${c}"/>`,
    shield: (x, y, c) =>
        line(`M${x + 10} ${y + 2} L${x + 17} ${y + 5} V${y + 10} c0 4.5 -3 7 -7 8 c-4 -1 -7 -3.5 -7 -8 V${y + 5} Z M${x + 7} ${y + 10} L${x + 9.5} ${y + 12.5} L${x + 13.5} ${y + 7.5}`, { stroke: c }),
};

function svg(w, h, t, body, label) {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">\n` +
        `<defs>${marker("arrow-fg", t.fg)}</defs>\n` +
        body +
        `\n</svg>\n`
    );
}

// ---------------------------------------------------------------------------
// The topology.
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

mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
    writeFileSync(join(OUT, `how-it-works-${name}.svg`), topology(t));
}
console.log(`wrote 2 figures to ${OUT}`);

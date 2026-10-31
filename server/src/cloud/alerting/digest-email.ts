// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { button, escapeHtml, renderLayout, type EmailContent } from "../email/layout.js";

/**
 * The weekly digest. Plain-text first: every line below is
 * written for the `text` part and the HTML is the same lines with links.
 * The mail is the Dashboard's first screen in prose: the Risk Score and
 * where it moved, the "Start here" rows, the week's new KEV matches and any
 * coverage gap only an operator can close.
 */

/** Upgrades that are someone else's to ship, and images with nothing to do but wait. */
export interface DigestUpstream {
    chartUpgrades: number;
    imageUpgrades: number;
    /** Findings the measured upstream upgrades remove. */
    findingsRemoved: number;
    /** Third-party images with findings and no upgrade to recommend. */
    waitingImages: number;
}

export interface DigestFinding {
    vulnId: string;
    packageName: string;
    packageVersion: string | null;
    fixedVersion: string | null;
    /** The 0–100 contribution. */
    risk: number;
    kev: boolean;
    epssScore: number | null;
    imageLabel: string;
    imageId: string;
    clusterName: string;
    workloadCount: number;
    /** Running containers on the image — the number the email prints. */
    containerCount: number;
}

export interface DigestEmailInput {
    orgName: string;
    /** Display name; null falls back to a nameless greeting. */
    name: string | null;
    /** `YYYY-Www`. */
    week: string;
    riskScore: number;
    /** Null when there is no snapshot a week old to compare with. */
    riskScoreWeekAgo: number | null;
    findingCount: number;
    topFindings: DigestFinding[];
    /** What "Start here" was drawn from — the org's default findings view. */
    startHereScope: "application" | "all";
    /** Null when the fix list could not be assembled; the line is then left out. */
    upstream: DigestUpstream | null;
    /** Findings that arrived in base images this week, and on how many images. */
    baseImageArrivals: { findings: number; images: number };
    /** Findings currently in base images, org-wide — the bucket "Start here" leaves out. */
    baseImageFindings: number;
    /** Measured base-image rebuilds available; null when the fix list could not be assembled. */
    baseRebuilds: { count: number; findingsRemoved: number } | null;
    newKevVulnIds: string[];
    newFindings: number;
    resolvedFindings: number;
    /** Registry hosts the scanner could not authenticate to, with the container count blocked on each. */
    coverageProblems: { clusterName: string; hosts: string[]; workloads: number }[];
    appUrl: string;
    unsubscribeUrl: string;
}

function fmt(n: number): string {
    return Math.round(n).toLocaleString("en-GB");
}

function deltaLine(now: number, before: number | null): string {
    if (before == null) return "no snapshot a week ago to compare with";
    const d = Math.round(now) - Math.round(before);
    if (d === 0) return "unchanged over the week";
    return d < 0 ? `down ${fmt(-d)} over the week` : `up ${fmt(d)} over the week`;
}

function findingText(f: DigestFinding): string {
    const pkg = f.packageVersion ? `${f.packageName}@${f.packageVersion}` : f.packageName;
    const fix = f.fixedVersion ? `fixed in ${f.fixedVersion}` : "no fix version stated";
    const why = f.kev ? "on CISA KEV" : f.epssScore != null ? `EPSS ${f.epssScore.toFixed(3)}` : "EPSS —";
    const where = `${f.imageLabel} (${f.clusterName}, ${f.containerCount} container${f.containerCount === 1 ? "" : "s"})`;
    return `${fmt(f.risk)}/100  ${f.vulnId}  ${pkg} — ${fix} — ${why}\n        in ${where}`;
}

/**
 * The base image's one line. Rows are for what the reader can act on; the
 * base bucket is said once, as a count, so it is folded and not hidden.
 */
function baseImageLine(
    input: Pick<DigestEmailInput, "baseImageArrivals" | "baseImageFindings" | "baseRebuilds">,
): string | null {
    const { findings, images } = input.baseImageArrivals;
    const total = `${fmt(input.baseImageFindings)} finding${input.baseImageFindings === 1 ? " is" : "s are"} in base images`;
    // What to do about it, when something can be said: a rebuild, measured.
    const rebuilds = input.baseRebuilds;
    const action =
        rebuilds && rebuilds.count > 0
            ? ` ${fmt(rebuilds.count)} rebuild${rebuilds.count === 1 ? "" : "s"} on a newer base would remove ${fmt(rebuilds.findingsRemoved)} of them.`
            : "";
    if (findings > 0) {
        return `Base images: ${fmt(findings)} new across ${fmt(images)} image${images === 1 ? "" : "s"} this week; ${total}.${action} Exploited ones are listed above.`;
    }
    return input.baseImageFindings > 0
        ? `Base images: ${total}; none arrived this week.${action} Exploited ones are listed above.`
        : null;
}

const startHereIntro = (scope: DigestEmailInput["startHereScope"]): string =>
    scope === "application" ? "in the application packages of images you control" : "across the images you control";

/** "Upstream: 3 chart upgrades available (removes 412 findings), 5 images waiting on upstream." */
function upstreamLine(upstream: DigestUpstream | null): string | null {
    if (!upstream) return null;
    const parts: string[] = [];
    const plural = (n: number, one: string) => `${fmt(n)} ${one}${n === 1 ? "" : "s"}`;
    const upgrades = [
        upstream.chartUpgrades > 0 ? plural(upstream.chartUpgrades, "chart upgrade") : null,
        upstream.imageUpgrades > 0 ? plural(upstream.imageUpgrades, "image upgrade") : null,
    ].filter(Boolean);
    if (upgrades.length > 0) {
        parts.push(
            `${upgrades.join(" and ")} available${upstream.findingsRemoved > 0 ? ` (removes ${plural(upstream.findingsRemoved, "finding")})` : ""}`,
        );
    }
    if (upstream.waitingImages > 0) parts.push(`${plural(upstream.waitingImages, "image")} waiting on upstream`);
    return parts.length > 0 ? `Upstream: ${parts.join(", ")}.` : null;
}

export function renderDigestEmail(input: DigestEmailInput): EmailContent {
    const greeting = input.name ? `Hi ${input.name},` : "Hi,";
    const riskScoreUrl = `${input.appUrl}/risk-score`;
    const feedUrl = `${input.appUrl}/feed`;
    const subject = `${input.orgName}: Risk Score ${fmt(input.riskScore)}, ${deltaLine(input.riskScore, input.riskScoreWeekAgo)}`;

    const textLines: string[] = [
        greeting,
        "",
        `Your weekly StackRadar summary for ${input.orgName} (week ${input.week}).`,
        "",
        `Risk Score: ${fmt(input.riskScore)} — ${deltaLine(input.riskScore, input.riskScoreWeekAgo)}, summed over ${fmt(input.findingCount)} finding${input.findingCount === 1 ? "" : "s"}.`,
        `See what drives it: ${riskScoreUrl}`,
        "",
    ];
    const baseLine = baseImageLine(input);
    if (input.topFindings.length > 0) {
        textLines.push(
            `Start here — ${startHereIntro(input.startHereScope)}, exploited first, then by Risk Score contribution:`,
            "",
        );
        for (const f of input.topFindings) {
            textLines.push(`  ${findingText(f)}`, `        ${input.appUrl}/images/${f.imageId}`, "");
        }
    } else {
        textLines.push(
            input.baseImageFindings > 0
                ? "Start here: nothing in your application packages."
                : "Start here: nothing — no confirmed findings in your scanned images.",
            "",
        );
    }
    if (baseLine) textLines.push(baseLine, "");
    const upstreamText = upstreamLine(input.upstream);
    if (upstreamText) textLines.push(`${upstreamText} ${input.appUrl}/fixes`, "");
    textLines.push(
        input.newKevVulnIds.length > 0
            ? `New this week on CISA KEV, running in your clusters: ${input.newKevVulnIds.join(", ")}.`
            : "No new CISA KEV matches this week.",
        `Findings: +${fmt(input.newFindings)} arrived, −${fmt(input.resolvedFindings)} resolved. What changed, day by day: ${feedUrl}`,
        "",
    );
    if (input.coverageProblems.length > 0) {
        textLines.push(
            "Coverage: the scanner cannot pull from these registries, so their images are missing from every number above:",
        );
        for (const c of input.coverageProblems) {
            textLines.push(
                `  ${c.clusterName}: ${c.hosts.join(", ")} (${c.workloads} container${c.workloads === 1 ? "" : "s"} unscanned)`,
            );
        }
        textLines.push("");
    }
    textLines.push(
        "—",
        `You get this once a week because you are an owner or admin of ${input.orgName}.`,
        `Turn it off for the whole organisation: ${input.unsubscribeUrl}`,
    );
    const text = textLines.join("\n");

    const findingsHtml =
        input.topFindings.length > 0
            ? `<ol style="padding-left:20px;margin:0 0 16px;">${input.topFindings
                  .map((f) => {
                      const pkg = f.packageVersion ? `${f.packageName}@${f.packageVersion}` : f.packageName;
                      const fix = f.fixedVersion ? `fixed in ${f.fixedVersion}` : "no fix version stated";
                      const why = f.kev
                          ? "on CISA KEV"
                          : f.epssScore != null
                            ? `EPSS ${f.epssScore.toFixed(3)}`
                            : "EPSS —";
                      return `<li style="margin-bottom:10px;"><strong>${fmt(f.risk)}/100</strong> <code>${escapeHtml(f.vulnId)}</code> ${escapeHtml(pkg)} — ${escapeHtml(fix)} — ${escapeHtml(why)}<br><span style="color:#6b7280;font-size:13px;">in <a href="${escapeHtml(`${input.appUrl}/images/${f.imageId}`)}" style="color:#2563eb;">${escapeHtml(f.imageLabel)}</a> (${escapeHtml(f.clusterName)}, ${f.containerCount} container${f.containerCount === 1 ? "" : "s"})</span></li>`;
                  })
                  .join("")}</ol>`
            : `<p>${input.baseImageFindings > 0 ? "Nothing in your application packages." : "Nothing — no confirmed findings in your scanned images."}</p>`;

    const coverageHtml =
        input.coverageProblems.length > 0
            ? `<p><strong>Coverage.</strong> The scanner cannot pull from these registries, so their images are missing from every number above:</p><ul>${input.coverageProblems
                  .map(
                      (c) =>
                          `<li>${escapeHtml(c.clusterName)}: ${escapeHtml(c.hosts.join(", "))} (${c.workloads} container${c.workloads === 1 ? "" : "s"} unscanned)</li>`,
                  )
                  .join("")}</ul>`
            : "";

    const bodyHtml = `
<p>${escapeHtml(greeting)}</p>
<p>Your weekly StackRadar summary for <strong>${escapeHtml(input.orgName)}</strong> (week ${escapeHtml(input.week)}).</p>
<p><strong>Risk Score ${fmt(input.riskScore)}</strong> — ${escapeHtml(deltaLine(input.riskScore, input.riskScoreWeekAgo))}, summed over ${fmt(input.findingCount)} finding${input.findingCount === 1 ? "" : "s"}.</p>
${button(riskScoreUrl, "See what drives the score")}
<p><strong>Start here</strong> — ${escapeHtml(startHereIntro(input.startHereScope))}, exploited first, then by Risk Score contribution:</p>
${findingsHtml}
${baseLine ? `<p style="color:#6b7280;">${escapeHtml(baseLine)}</p>` : ""}
${upstreamText ? `<p style="color:#6b7280;">${escapeHtml(upstreamText)} <a href="${escapeHtml(`${input.appUrl}/fixes`)}" style="color:#2563eb;">See the upgrades</a>.</p>` : ""}
<p>${
        input.newKevVulnIds.length > 0
            ? `New this week on CISA KEV, running in your clusters: <code>${input.newKevVulnIds.map(escapeHtml).join("</code>, <code>")}</code>.`
            : "No new CISA KEV matches this week."
    }<br>Findings: +${fmt(input.newFindings)} arrived, −${fmt(input.resolvedFindings)} resolved. <a href="${escapeHtml(feedUrl)}" style="color:#2563eb;">What changed, day by day</a>.</p>
${coverageHtml}
<p style="font-size:13px;color:#6b7280;">You get this once a week because you are an owner or admin of ${escapeHtml(input.orgName)}. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280;">Turn it off for the whole organisation</a>.</p>`;

    return { subject, html: renderLayout({ preheader: subject, bodyHtml }), text };
}

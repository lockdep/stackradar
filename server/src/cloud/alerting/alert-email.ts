// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { escapeHtml, renderLayout, type EmailContent } from "../email/layout.js";
import {
    alertSubject,
    clusterList,
    fmt,
    imageLine,
    plural,
    reasonLabel,
    severityLabel,
    vulnUrl,
    type AlertMessageInput,
} from "../../lib/alert-message.js";

/**
 * The critical & KEV alert as an email (owners and admins). Same content
 * as the webhook message in `lib/alert-message.ts`, grouped by advisory,
 * exploited first, plain text first like the digest — the HTML is the
 * same lines with links — plus the unsubscribe link only a mail needs.
 *
 * Every value here is scanner- or advisory-supplied text and goes through
 * `escapeHtml` on the way into HTML.
 */

export interface AlertRenderInput extends AlertMessageInput {
    /** The signed, session-less link that switches the email channel off (`unsubscribe-token.ts`). */
    unsubscribeUrl: string;
}

function notificationFooter(orgName: string, settingsUrl: string, unsubscribeUrl: string): string {
    return `You get critical &amp; KEV alerts because you are an owner or admin of ${escapeHtml(orgName)}. <a href="${escapeHtml(settingsUrl)}" style="color:#6b7280;">Change what is alerted</a> · <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a> (switches alert email off for the whole organisation).`;
}

export function renderAlertEmail(input: AlertRenderInput): EmailContent {
    const subject = alertSubject(input);
    const lines: string[] = [
        "Hi,",
        "",
        `StackRadar found ${plural(input.items.length, "advisory", "advisories")} that ${input.items.length === 1 ? "needs" : "need"} attention on images ${input.orgName} is running right now.`,
        "",
    ];
    for (const item of input.items) {
        lines.push(
            `${item.vulnId} — ${severityLabel(item)} — ${fmt(item.riskScore)}/100 — ${reasonLabel(item.reason)}`,
        );
        if (item.packages.length > 0) {
            lines.push(
                `  ${item.packages.join(", ")}${item.fixedVersion ? ` — fixed in ${item.fixedVersion}` : " — no fix version stated"}`,
            );
        }
        const clusters = clusterList(item, input.clusterNames);
        lines.push(`  ${plural(item.imageCount, "running image")}${clusters ? ` in ${clusters}` : ""}:`);
        for (const img of item.images) lines.push(`    ${imageLine(img, input.clusterNames)}`);
        if (item.imageCount > item.images.length)
            lines.push(`    … and ${fmt(item.imageCount - item.images.length)} more`);
        lines.push(`  ${vulnUrl(input.appUrl, item.vulnId)}`, "");
    }
    lines.push(
        "—",
        `You get this within minutes of a critical or known-exploited finding landing on a running image because you are an owner or admin of ${input.orgName}.`,
        `Change what is alerted: ${input.settingsUrl}`,
        `Unsubscribe (switches alert email off for the whole organisation): ${input.unsubscribeUrl}`,
    );
    const text = lines.join("\n");

    const itemsHtml = input.items
        .map((item) => {
            const pkgs =
                item.packages.length > 0
                    ? `<div style="color:#374151;">${escapeHtml(item.packages.join(", "))}${item.fixedVersion ? ` — fixed in ${escapeHtml(item.fixedVersion)}` : " — no fix version stated"}</div>`
                    : "";
            const clusters = clusterList(item, input.clusterNames);
            const images = item.images
                .map((img) => {
                    const label = escapeHtml(imageLine(img, input.clusterNames));
                    return img.imageId
                        ? `<li><a href="${escapeHtml(`${input.appUrl}/images/${img.imageId}`)}" style="color:#2563eb;">${label}</a></li>`
                        : `<li>${label}</li>`;
                })
                .join("");
            const more =
                item.imageCount > item.images.length
                    ? `<li style="color:#6b7280;">… and ${fmt(item.imageCount - item.images.length)} more</li>`
                    : "";
            return `<div style="margin:0 0 20px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:6px;">
<div><a href="${escapeHtml(vulnUrl(input.appUrl, item.vulnId))}" style="color:#111827;font-weight:600;text-decoration:none;"><code>${escapeHtml(item.vulnId)}</code></a> · ${escapeHtml(severityLabel(item))} · <strong>${fmt(item.riskScore)}/100</strong></div>
<div style="color:#6b7280;font-size:13px;">${escapeHtml(reasonLabel(item.reason))}</div>
${pkgs}
<div style="margin-top:8px;">${escapeHtml(plural(item.imageCount, "running image"))}${clusters ? ` in ${escapeHtml(clusters)}` : ""}:</div>
<ul style="margin:4px 0 0;padding-left:20px;font-size:13px;">${images}${more}</ul>
</div>`;
        })
        .join("");

    const bodyHtml = `
<p>Hi,</p>
<p>StackRadar found ${escapeHtml(plural(input.items.length, "advisory", "advisories"))} that ${input.items.length === 1 ? "needs" : "need"} attention on images <strong>${escapeHtml(input.orgName)}</strong> is running right now.</p>
${itemsHtml}`;

    return {
        subject,
        text,
        html: renderLayout({
            preheader: subject,
            bodyHtml,
            footerHtml: notificationFooter(input.orgName, input.settingsUrl, input.unsubscribeUrl),
        }),
    };
}

/** The settings page's "send a test": proves the channel works, says nothing about findings. */
export function renderTestAlertEmail(input: {
    orgName: string;
    settingsUrl: string;
    unsubscribeUrl: string;
}): EmailContent {
    const subject = `Test alert from StackRadar for ${input.orgName}`;
    const text = [
        "Hi,",
        "",
        `This is a test of the critical & KEV alerts for ${input.orgName}. If you are reading it, the email channel works.`,
        "",
        "A real alert names the advisory, the packages it is in, the running images it landed on and the cluster each is in, within minutes of the finding appearing.",
        "",
        "—",
        `Change what is alerted: ${input.settingsUrl}`,
        `Unsubscribe: ${input.unsubscribeUrl}`,
    ].join("\n");
    const bodyHtml = `
<p>Hi,</p>
<p>This is a test of the critical &amp; KEV alerts for <strong>${escapeHtml(input.orgName)}</strong>. If you are reading it, the email channel works.</p>
<p>A real alert names the advisory, the packages it is in, the running images it landed on and the cluster each is in, within minutes of the finding appearing.</p>`;
    return {
        subject,
        text,
        html: renderLayout({
            preheader: subject,
            bodyHtml,
            footerHtml: notificationFooter(input.orgName, input.settingsUrl, input.unsubscribeUrl),
        }),
    };
}

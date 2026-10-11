// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { button, escapeHtml, renderLayout, type EmailContent } from "./layout.js";

export interface InviteEmailInput {
    orgName: string;
    /** Display name or email of the inviter; null when unknown. */
    inviterName: string | null;
    role: string;
    inviteUrl: string;
    expiresAt: Date;
}

function formatDate(d: Date): string {
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function renderInviteEmail(input: InviteEmailInput): EmailContent {
    const who = input.inviterName ? `${input.inviterName} has invited you` : "You have been invited";
    const subject = input.inviterName
        ? `${input.inviterName} invited you to join ${input.orgName} on StackRadar`
        : `You're invited to join ${input.orgName} on StackRadar`;
    const expires = formatDate(input.expiresAt);

    const bodyHtml = `
<p>${escapeHtml(who)} to join <strong>${escapeHtml(input.orgName)}</strong> on StackRadar as a${input.role === "admin" ? "n" : ""} <strong>${escapeHtml(input.role)}</strong>.</p>
<p>StackRadar tracks the software running in your Kubernetes clusters and tells you which vulnerabilities actually matter.</p>
${button(input.inviteUrl, "Accept invitation")}
<p style="font-size:13px;color:#6b7280;">Or paste this link into your browser:<br><a href="${escapeHtml(input.inviteUrl)}" style="color:#2563eb;word-break:break-all;">${escapeHtml(input.inviteUrl)}</a></p>
<p style="font-size:13px;color:#6b7280;">This invitation expires on ${escapeHtml(expires)}.</p>`;

    const text = [
        `${who} to join ${input.orgName} on StackRadar as ${input.role === "admin" ? "an" : "a"} ${input.role}.`,
        "",
        "Accept the invitation:",
        input.inviteUrl,
        "",
        `This invitation expires on ${expires}.`,
        "",
        "If you weren't expecting this, you can ignore this email.",
    ].join("\n");

    return { subject, html: renderLayout({ preheader: `Join ${input.orgName} on StackRadar`, bodyHtml }), text };
}

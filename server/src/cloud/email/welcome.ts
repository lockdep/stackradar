// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { button, escapeHtml, renderLayout, type EmailContent } from "./layout.js";

export type WelcomeVariant =
    /** Signed up on their own: they own a fresh org and nothing is connected yet. */
    | { kind: "new_org"; orgName: string }
    /** Signed up through an invite link: they joined someone else's org. */
    | { kind: "joined_org"; orgName: string; role: string };

export interface WelcomeEmailInput {
    /** Display name; null falls back to a nameless greeting. */
    name: string | null;
    variant: WelcomeVariant;
    appUrl: string;
    docsUrl: string;
}

export function renderWelcomeEmail(input: WelcomeEmailInput): EmailContent {
    const greeting = input.name ? `Hi ${input.name},` : "Hi,";
    const quickStart = `${input.docsUrl}/quick-start`;

    if (input.variant.kind === "new_org") {
        const subject = "Welcome to StackRadar — connect your first cluster";
        const bodyHtml = `
<p>${escapeHtml(greeting)}</p>
<p>Your StackRadar account is ready and your organisation <strong>${escapeHtml(input.variant.orgName)}</strong> is set up.</p>
<p>Nothing shows up until a cluster is connected. The scanner is a Helm chart that runs inside your cluster, builds an SBOM for every running image and sends it to StackRadar — takes about five minutes.</p>
${button(quickStart, "Connect a cluster")}
<p>From there you'll see which of your workloads carry vulnerabilities that actually matter — ranked by exploitability, not just CVSS.</p>
<p style="font-size:13px;color:#6b7280;">Questions? Reply to this email.</p>`;
        const text = [
            greeting,
            "",
            `Your StackRadar account is ready and your organisation "${input.variant.orgName}" is set up.`,
            "",
            "Nothing shows up until a cluster is connected. The scanner is a Helm chart that runs inside your cluster, builds an SBOM for every running image and sends it to StackRadar — takes about five minutes.",
            "",
            `Connect a cluster: ${quickStart}`,
            "",
            "From there you'll see which of your workloads carry vulnerabilities that actually matter — ranked by exploitability, not just CVSS.",
            "",
            "Questions? Reply to this email.",
        ].join("\n");
        return { subject, html: renderLayout({ preheader: "Connect your first cluster to get started", bodyHtml }), text };
    }

    const { orgName, role } = input.variant;
    const article = role === "admin" ? "an" : "a";
    const subject = `Welcome to StackRadar — you've joined ${orgName}`;
    const bodyHtml = `
<p>${escapeHtml(greeting)}</p>
<p>You've joined <strong>${escapeHtml(orgName)}</strong> on StackRadar as ${article} <strong>${escapeHtml(role)}</strong>.</p>
<p>StackRadar tracks the software running in your team's Kubernetes clusters and ranks vulnerabilities by whether they're actually exploitable — so you fix what matters first.</p>
${button(input.appUrl, "Open StackRadar")}
<p style="font-size:13px;color:#6b7280;">New to the product? The <a href="${escapeHtml(input.docsUrl)}" style="color:#2563eb;">docs</a> explain how findings are scored. Questions? Reply to this email.</p>`;
    const text = [
        greeting,
        "",
        `You've joined ${orgName} on StackRadar as ${article} ${role}.`,
        "",
        "StackRadar tracks the software running in your team's Kubernetes clusters and ranks vulnerabilities by whether they're actually exploitable — so you fix what matters first.",
        "",
        `Open StackRadar: ${input.appUrl}`,
        `Docs: ${input.docsUrl}`,
        "",
        "Questions? Reply to this email.",
    ].join("\n");
    return { subject, html: renderLayout({ preheader: `You've joined ${orgName} on StackRadar`, bodyHtml }), text };
}

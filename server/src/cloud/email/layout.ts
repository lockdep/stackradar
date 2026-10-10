// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * Plain-HTML transactional email layout. Templates are TS functions rather
 * than React Email so the Express server does not grow a React dependency;
 * every value interpolated into HTML goes through `escapeHtml`.
 */

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export interface EmailContent {
    subject: string;
    html: string;
    text: string;
}

export function renderLayout(opts: {
    preheader: string;
    bodyHtml: string;
    /**
     * The footer line, already HTML. Defaults to the transactional one; a
     * notification (digest, alert) says why the reader gets it and carries
     * its unsubscribe link here, where mail clients look for one.
     */
    footerHtml?: string;
}): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StackRadar</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:8px;padding:32px;">
<tr><td style="font-size:18px;font-weight:600;padding-bottom:24px;">StackRadar</td></tr>
<tr><td style="font-size:15px;line-height:1.6;">${opts.bodyHtml}</td></tr>
<tr><td style="font-size:12px;color:#6b7280;padding-top:32px;border-top:1px solid #e5e7eb;margin-top:32px;">
${opts.footerHtml ?? "You received this email because someone used StackRadar to contact this address. If you weren't expecting it, you can ignore it."}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function button(href: string, label: string): string {
    return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a></p>`;
}

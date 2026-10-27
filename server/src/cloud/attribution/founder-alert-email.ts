// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { escapeHtml, renderLayout, type EmailContent } from "../email/layout.js";

/**
 * The two founder alerts: "someone signed up" and "their first cluster
 * reported in". Internal mail to the operator, so unlike the other
 * templates it names the person — the whole point is to reply to them.
 *
 * Every field is a plain label. Nothing here is interpreted, and every
 * value is user- or scanner-supplied text, so all of it goes through
 * `escapeHtml` on the way into the HTML variant.
 */

export interface FounderAlertPerson {
    email: string;
    name: string | null;
}

export interface FounderAlertOrigin {
    /** The browser's IANA time zone at sign-up, e.g. `Europe/Oslo`. */
    timezone: string | null;
    /** The browser's first `Accept-Language` tag at sign-up, e.g. `nb-NO`. */
    locale: string | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmContent: string | null;
    /** Which ad network's click the sign-up carried, if any. */
    adNetwork: string | null;
}

export interface SignupAlertInput {
    person: FounderAlertPerson;
    org: { id: string; name: string };
    origin: FounderAlertOrigin;
    signedUpAt: Date;
    /** Where the operator can look the org up. */
    adminUrl: string;
}

export interface ClusterAlertInput {
    person: FounderAlertPerson;
    org: { id: string; name: string };
    origin: FounderAlertOrigin;
    cluster: { id: string; name: string };
    /** What the first report contained. */
    accepted: { namespaces: number; workloads: number; containers: number };
    scannerVersion: string | null;
    hoursSinceSignup: number;
    adminUrl: string;
}

export interface TrialAlertInput {
    /** `started`: a trial began (a card was saved). `converted`: the card was charged at the end of it. */
    kind: "started" | "converted";
    /** Who checked out; null when the org has no owner row to name. */
    person: FounderAlertPerson | null;
    org: { id: string; name: string };
    plan: "pro" | "team";
    interval: string | null;
    priceBook: string | null;
    trialEnd: Date | null;
    subscriptionId: string;
    adminUrl: string;
}

/** A row of the key/value list every alert is. */
type Field = [label: string, value: string | null];

export function renderSignupAlert(input: SignupAlertInput): EmailContent {
    const who = personLabel(input.person);
    const where = whereLabel(input.origin);
    const subject = `New sign-up: ${who}${where ? ` (${where})` : ""}`;
    const fields: Field[] = [
        ["Name", input.person.name],
        ["Email", input.person.email],
        ["Organisation", input.org.name],
        ["Time zone", input.origin.timezone],
        ["Language", input.origin.locale],
        ["Source", sourceLabel(input.origin)],
        ["Signed up", input.signedUpAt.toISOString()],
        ["Org id", input.org.id],
    ];
    return render({
        subject,
        preheader: `${who} just created ${input.org.name}`,
        intro: "Someone just signed up. Reply to this email to reach them.",
        fields,
        adminUrl: input.adminUrl,
    });
}

export function renderClusterAlert(input: ClusterAlertInput): EmailContent {
    const who = personLabel(input.person);
    const subject = `Cluster connected: ${input.org.name} · ${input.cluster.name}`;
    const fields: Field[] = [
        ["Organisation", input.org.name],
        ["Cluster", input.cluster.name],
        [
            "Reported",
            `${input.accepted.containers} containers in ${input.accepted.workloads} workloads across ${input.accepted.namespaces} namespaces`,
        ],
        ["Scanner", input.scannerVersion],
        ["Time since sign-up", `${input.hoursSinceSignup} h`],
        ["Founder", who],
        ["Email", input.person.email],
        ["Time zone", input.origin.timezone],
        ["Language", input.origin.locale],
        ["Source", sourceLabel(input.origin)],
        ["Org id", input.org.id],
        ["Cluster id", input.cluster.id],
    ];
    return render({
        subject,
        preheader: `${input.org.name}'s first inventory just landed`,
        intro: "Their first cluster just reported in — the moment to offer a call. Reply to this email to reach them.",
        fields,
        adminUrl: input.adminUrl,
    });
}

/** The same two alerts as a Slack `mrkdwn` message. */
/** "Pro · monthly · beta price", from what the subscription says about itself. */
function planLabel(input: TrialAlertInput): string {
    const name = input.plan === "team" ? "Business" : "Pro";
    const interval = input.interval === "year" ? "annual" : input.interval === "month" ? "monthly" : null;
    const book = input.priceBook === "beta" ? "beta price" : input.priceBook === "standard" ? "standard price" : null;
    return [name, interval, book].filter(Boolean).join(" · ");
}

export function renderTrialAlert(input: TrialAlertInput): EmailContent {
    const who = input.person ? personLabel(input.person) : "unknown";
    const subject =
        input.kind === "started"
            ? `Trial started: ${input.org.name} (${planLabel(input)})`
            : `Trial converted: ${input.org.name} (${planLabel(input)})`;
    const fields: Field[] = [
        ["Organisation", input.org.name],
        ["Plan", planLabel(input)],
        ...(input.kind === "started" ? [["Trial ends", input.trialEnd?.toISOString() ?? null] as Field] : []),
        ["Person", who],
        ["Email", input.person?.email ?? null],
        ["Org id", input.org.id],
        ["Subscription", input.subscriptionId],
    ];
    return render({
        subject,
        preheader:
            input.kind === "started"
                ? `${who} saved a card and started a ${planLabel(input)} trial`
                : `${who} is now paying for ${planLabel(input)}`,
        intro:
            input.kind === "started"
                ? "Someone started a free trial. Nothing is charged until it ends; reply to this email to reach them."
                : "A trial just converted to a paid plan. Reply to this email to say thanks.",
        fields,
        adminUrl: input.adminUrl,
    });
}

export function renderTrialAlertSlack(input: TrialAlertInput): string {
    const who = input.person ? personLabel(input.person) : "unknown";
    const head = input.kind === "started" ? "*Trial started:*" : "*Trial converted:*";
    return [
        `${head} ${input.org.name} · ${planLabel(input)}`,
        input.kind === "started" && input.trialEnd ? `Ends ${input.trialEnd.toISOString().slice(0, 10)} · ${who}` : who,
        `<${input.adminUrl}|Open admin>`,
    ].join("\n");
}

export function renderSignupAlertSlack(input: SignupAlertInput): string {
    const where = whereLabel(input.origin);
    return [
        `*New sign-up:* ${personLabel(input.person)}${where ? ` (${where})` : ""}`,
        `Org: ${input.org.name} · Source: ${sourceLabel(input.origin)}`,
        `Email: ${input.person.email}`,
        `<${input.adminUrl}|Open admin>`,
    ].join("\n");
}

export function renderClusterAlertSlack(input: ClusterAlertInput): string {
    return [
        `*Cluster connected:* ${input.org.name} · ${input.cluster.name}`,
        `${input.accepted.containers} containers, ${input.accepted.workloads} workloads, ${input.accepted.namespaces} namespaces · scanner ${input.scannerVersion ?? "unknown"} · ${input.hoursSinceSignup} h after sign-up`,
        `Founder: ${personLabel(input.person)} <${input.person.email}>`,
        `<${input.adminUrl}|Open admin>`,
    ].join("\n");
}

function personLabel(person: FounderAlertPerson): string {
    return person.name ? `${person.name} <${person.email}>` : person.email;
}

/** "Europe/Oslo · nb-NO", or whichever half is known. */
function whereLabel(origin: FounderAlertOrigin): string {
    return [origin.timezone, origin.locale].filter(Boolean).join(" · ");
}

/** "reddit / cpc / k8s-a4 (reddit ad)", or "organic / direct". */
function sourceLabel(origin: FounderAlertOrigin): string {
    const tags = [origin.utmSource, origin.utmMedium, origin.utmCampaign, origin.utmContent]
        .filter(Boolean)
        .join(" / ");
    if (!tags && !origin.adNetwork) return "organic / direct";
    return origin.adNetwork ? `${tags || "untagged"} (${origin.adNetwork} ad)` : tags;
}

function render(opts: {
    subject: string;
    preheader: string;
    intro: string;
    fields: Field[];
    adminUrl: string;
}): EmailContent {
    const rows = opts.fields
        .map(
            ([label, value]) =>
                `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
                `<td style="padding:4px 0;">${value ? escapeHtml(value) : '<span style="color:#9ca3af;">—</span>'}</td></tr>`,
        )
        .join("\n");
    const bodyHtml = `
<p>${escapeHtml(opts.intro)}</p>
<table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.5;">
${rows}
</table>
<p style="margin-top:24px;"><a href="${escapeHtml(opts.adminUrl)}" style="color:#2563eb;">Open admin</a></p>`;
    const text = [
        opts.intro,
        "",
        ...opts.fields.map(([label, value]) => `${label}: ${value ?? "—"}`),
        "",
        `Admin: ${opts.adminUrl}`,
    ].join("\n");
    return { subject: opts.subject, html: renderLayout({ preheader: opts.preheader, bodyHtml }), text };
}

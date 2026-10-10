import { config } from "../config/index.js";
import type { AlertItem, AlertReason } from "./alert-batch.js";

/**
 * The critical & KEV alert as a webhook message — the community edition's
 * one alert channel, and the cloud's Slack channel. One block of `mrkdwn`
 * text posted as `{ text }`: Slack, Mattermost, Discord's Slack-compatible
 * endpoint and Microsoft Teams all render that, and the alert has nothing
 * that needs a button. The email rendering, which adds an unsubscribe
 * link and HTML, is the cloud's (`cloud/alerting/alert-email.ts`) and
 * shares the labels below.
 *
 * Every value here is scanner- or advisory-supplied text; the webhook
 * text gets the three characters mrkdwn reserves escaped (`&`, `<`, `>`).
 */

export interface AlertMessageInput {
    orgName: string;
    items: AlertItem[];
    /** Cluster id → name, for the images' "in prod-eu" labels. */
    clusterNames: Record<string, string>;
    appUrl: string;
    /** Where the reader changes what is alerted — the notifications tab. */
    settingsUrl: string;
}

/** Where the reader changes what is alerted. */
export function alertSettingsUrl(): string {
    return `${config.appUrl}/org-settings?tab=notifications`;
}

export function fmt(n: number): string {
    return Math.round(n).toLocaleString("en-GB");
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${fmt(n)} ${n === 1 ? one : many}`;
}

/** The one-line reason, as the reader should hear it. */
export function reasonLabel(reason: AlertReason): string {
    switch (reason) {
        case "kev-listed":
            return "CISA added it to the Known Exploited Vulnerabilities catalogue; it was already running";
        case "new-kev":
            return "new finding, on CISA KEV";
        case "new-critical":
            return "new critical finding";
        case "rescored-critical":
            return "rescored to critical";
    }
}

/** "critical, on CISA KEV" / "high, on CISA KEV" / "critical". */
export function severityLabel(item: AlertItem): string {
    const level = item.severityLevel ? item.severityLevel.toLowerCase() : "unscored";
    return item.kevListed ? `${level}, on CISA KEV` : level;
}

export function imageName(img: AlertItem["images"][number]): string {
    if (img.repository) return img.repository;
    if (img.digest) return img.digest.slice(0, 19);
    return "image";
}

export function clusterList(item: AlertItem, names: Record<string, string>): string {
    const labels = item.clusterIds.map((id) => names[id] ?? id.slice(0, 8));
    return labels.join(", ");
}

/** The subject line — one advisory names itself, more than one is a count. */
export function alertSubject(input: Pick<AlertMessageInput, "orgName" | "items">): string {
    const [first] = input.items;
    if (input.items.length === 1 && first) {
        const kind = first.kevListed ? "Known exploited" : "Critical";
        return `${kind}: ${first.vulnId} on ${plural(first.imageCount, "running image")} in ${input.orgName}`;
    }
    const kev = input.items.filter((i) => i.kevListed).length;
    const what =
        kev === input.items.length
            ? plural(input.items.length, "known-exploited finding")
            : kev > 0
              ? `${plural(input.items.length, "new finding")}, ${kev} known exploited`
              : plural(input.items.length, "new critical finding");
    return `${what} on running images in ${input.orgName}`;
}

export function vulnUrl(appUrl: string, vulnId: string): string {
    return `${appUrl}/vulnerabilities/${encodeURIComponent(vulnId)}`;
}

export function imageLine(img: AlertItem["images"][number], names: Record<string, string>): string {
    const where = [img.clusterId ? names[img.clusterId] ?? null : null, ...img.containers].filter(Boolean).join(", ");
    const count = img.containerCount != null ? `, ${plural(img.containerCount, "container")}` : "";
    return `${imageName(img)}${where ? ` (${where}${count})` : count ? ` (${count.slice(2)})` : ""}`;
}

function slackEscape(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The webhook message. */
export function renderAlertSlack(input: AlertMessageInput): string {
    const lines: string[] = [`:rotating_light: *${slackEscape(alertSubject(input))}*`, ""];
    for (const item of input.items) {
        const link = `<${vulnUrl(input.appUrl, item.vulnId)}|${slackEscape(item.vulnId)}>`;
        const kev = item.kevListed ? " · *on CISA KEV*" : "";
        const level = item.severityLevel ? item.severityLevel.toLowerCase() : "unscored";
        lines.push(`*${link}* · ${level}${kev} · ${fmt(item.riskScore)}/100 — ${slackEscape(reasonLabel(item.reason))}`);
        if (item.packages.length > 0) {
            lines.push(`${slackEscape(item.packages.join(", "))}${item.fixedVersion ? ` → fixed in ${slackEscape(item.fixedVersion)}` : " → no fix version stated"}`);
        }
        const clusters = clusterList(item, input.clusterNames);
        const images = item.images.map((img) => {
            const name = `\`${slackEscape(imageName(img))}\``;
            const where = img.containers.slice(0, 2).map(slackEscape).join(", ");
            const extra = img.containers.length > 2 ? `, +${img.containers.length - 2}` : "";
            return where ? `${name} (${where}${extra})` : name;
        });
        const more = item.imageCount > item.images.length ? `, … +${fmt(item.imageCount - item.images.length)}` : "";
        lines.push(`${plural(item.imageCount, "running image")}${clusters ? ` in ${slackEscape(clusters)}` : ""}: ${images.join(", ")}${more}`, "");
    }
    lines.push(`_Alerts for ${slackEscape(input.orgName)} · <${input.settingsUrl}|settings>_`);
    return lines.join("\n");
}

/** The settings page's "send a test": proves the webhook works, says nothing about findings. */
export function renderTestAlertSlack(input: { orgName: string; settingsUrl: string }): string {
    return [
        `:white_check_mark: *Test alert from StackRadar for ${slackEscape(input.orgName)}*`,
        "If you can read this, the webhook works. A real alert names the advisory, the packages, the running images and their clusters, within minutes of a critical or known-exploited finding appearing.",
        `_<${input.settingsUrl}|Alert settings>_`,
    ].join("\n");
}

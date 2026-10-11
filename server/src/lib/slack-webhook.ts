import { safeFetch, SafeFetchBlockedError } from "./safe-fetch.js";

const SLACK_TIMEOUT_MS = 10_000;

export type SlackPostResult = { status: "sent" } | { status: "failed"; error: string };

/**
 * Slack incoming webhook: one POST with `{ text }` in mrkdwn, answered with
 * a literal `ok`. No SDK — the URL carries the auth and there is nothing
 * else to configure. Shared by the founder alert (an operator-configured
 * URL) and the org alerts (a tenant-configured one).
 *
 * `untrusted: true` routes the request through `safeFetch`: a tenant's
 * webhook URL is attacker-supplied input this server POSTs to from inside
 * the cluster, and without the SSRF checks it is a request proxy against
 * everything the pod can reach. Slack, Mattermost and Discord all answer on
 * public hosts, so nothing legitimate is refused. Never throws.
 */
export async function postSlackWebhook(
    url: string,
    text: string,
    opts: { untrusted?: boolean } = {},
): Promise<SlackPostResult> {
    try {
        const body = JSON.stringify({ text });
        const headers = { "Content-Type": "application/json" };
        const res = opts.untrusted
            ? await safeFetch(url, { method: "POST", body, headers, timeoutMs: SLACK_TIMEOUT_MS })
            : await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(SLACK_TIMEOUT_MS) });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            return { status: "failed", error: `Webhook responded ${res.status}: ${detail.slice(0, 200)}` };
        }
        await res.body?.cancel().catch(() => {});
        return { status: "sent" };
    } catch (err) {
        if (err instanceof SafeFetchBlockedError) return { status: "failed", error: err.message };
        return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * The webhook URL as the settings page and the send log may show it: host
 * plus the last four characters of the path. The path *is* the credential.
 */
export function maskWebhookUrl(url: string): string {
    try {
        const u = new URL(url);
        const tail = u.pathname.replace(/\/+$/, "");
        return `${u.host}/…${tail.slice(-4)}`;
    } catch {
        return "…";
    }
}

/**
 * Whether a tenant-supplied webhook URL may be stored: `https:` only and a
 * host that resolves publicly is checked again at send time by `safeFetch`;
 * here the shape is checked so a paste of the wrong thing fails at save.
 */
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return { ok: false, error: "Not a valid URL" };
    }
    if (url.protocol !== "https:") return { ok: false, error: "The webhook URL must use https" };
    if (url.username || url.password) return { ok: false, error: "The webhook URL must not carry credentials" };
    if (!url.hostname.includes(".")) return { ok: false, error: "The webhook URL must name a public host" };
    if (url.pathname.length < 2) return { ok: false, error: "That does not look like a webhook URL" };
    return { ok: true, url: url.toString() };
}

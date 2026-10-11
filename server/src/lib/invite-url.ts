import { config } from "../config/index.js";

/**
 * The URL an invited user opens to accept an invite — the Next.js app hosts
 * the acceptance page. One definition for the API response (the admin
 * copies it) and the cloud's invite email (`cloud/hooks.ts`).
 */
export function buildInviteUrl(token: string): string {
    return `${config.appUrl}/invite/${token}`;
}

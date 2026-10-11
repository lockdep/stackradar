import { describe, it, expect } from "vitest";
import { renderInviteEmail } from "../../../src/cloud/email/invite.js";

const base = {
    orgName: "Acme",
    inviterName: "Ada Lovelace",
    role: "member",
    inviteUrl: "https://app.stackradar.io/invite/abc123",
    expiresAt: new Date("2026-09-01T00:00:00Z"),
};

describe("renderInviteEmail", () => {
    it("names the inviter and org in the subject", () => {
        const { subject } = renderInviteEmail(base);
        expect(subject).toBe("Ada Lovelace invited you to join Acme on StackRadar");
    });

    it("falls back when the inviter is unknown", () => {
        const { subject, text } = renderInviteEmail({ ...base, inviterName: null });
        expect(subject).toBe("You're invited to join Acme on StackRadar");
        expect(text).toContain("You have been invited to join Acme");
    });

    it("includes the invite URL in both html and text", () => {
        const { html, text } = renderInviteEmail(base);
        expect(html).toContain(`href="${base.inviteUrl}"`);
        expect(text).toContain(base.inviteUrl);
    });

    it("includes the expiry date", () => {
        const { html, text } = renderInviteEmail(base);
        expect(html).toContain("1 September 2026");
        expect(text).toContain("1 September 2026");
    });

    it("uses the right article for the role", () => {
        expect(renderInviteEmail(base).text).toContain("as a member");
        expect(renderInviteEmail({ ...base, role: "admin" }).text).toContain("as an admin");
    });

    it("escapes HTML in user-controlled fields", () => {
        const { html } = renderInviteEmail({
            ...base,
            orgName: `<script>alert(1)</script>`,
            inviterName: `Bob "B" <b@x>`,
        });
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
        expect(html).toContain("Bob &quot;B&quot; &lt;b@x&gt;");
    });
});

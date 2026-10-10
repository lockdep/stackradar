import { describe, it, expect } from "vitest";
import { renderWelcomeEmail } from "../../../src/cloud/email/welcome.js";

const base = { name: "Ada", appUrl: "https://app.test", docsUrl: "https://site.test/docs" };

describe("renderWelcomeEmail", () => {
    describe("new_org", () => {
        const email = renderWelcomeEmail({ ...base, variant: { kind: "new_org", orgName: "Ada's Org" } });

        it("pushes the user to connect a cluster", () => {
            expect(email.subject).toBe("Welcome to StackRadar — connect your first cluster");
            expect(email.html).toContain('href="https://site.test/docs/quick-start"');
            expect(email.text).toContain("Connect a cluster: https://site.test/docs/quick-start");
        });

        it("greets by name and names the org", () => {
            expect(email.html).toContain("Hi Ada,");
            expect(email.html).toContain("Ada&#39;s Org");
            expect(email.text).toContain(`"Ada's Org"`);
        });
    });

    describe("joined_org", () => {
        it("names the org and role and links to the app", () => {
            const email = renderWelcomeEmail({ ...base, variant: { kind: "joined_org", orgName: "Acme", role: "admin" } });
            expect(email.subject).toBe("Welcome to StackRadar — you've joined Acme");
            expect(email.text).toContain("joined Acme on StackRadar as an admin");
            expect(email.html).toContain('href="https://app.test"');
        });

        it("uses 'a member' for members", () => {
            const email = renderWelcomeEmail({ ...base, variant: { kind: "joined_org", orgName: "Acme", role: "member" } });
            expect(email.text).toContain("as a member");
        });
    });

    it("handles a missing name", () => {
        const email = renderWelcomeEmail({ ...base, name: null, variant: { kind: "new_org", orgName: "X" } });
        expect(email.text.startsWith("Hi,\n")).toBe(true);
    });

    it("escapes HTML in the org name", () => {
        const email = renderWelcomeEmail({ ...base, variant: { kind: "joined_org", orgName: "<b>Evil</b>", role: "member" } });
        expect(email.html).not.toContain("<b>Evil</b>");
        expect(email.html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    });
});

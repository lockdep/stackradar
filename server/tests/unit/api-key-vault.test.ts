import { describe, it, expect } from "vitest";
import { createApiKeyVault, decodeVaultKey, ApiKeyVaultError } from "../../src/lib/api-key-vault.js";

const HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_HEX_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("api-key-vault", () => {
    describe("decodeVaultKey", () => {
        it("accepts 64 hex characters", () => {
            expect(decodeVaultKey(HEX_KEY)).toHaveLength(32);
        });

        it("accepts base64 of 32 bytes", () => {
            const b64 = Buffer.from(HEX_KEY, "hex").toString("base64");
            expect(decodeVaultKey(b64).equals(Buffer.from(HEX_KEY, "hex"))).toBe(true);
        });

        it("rejects a key of the wrong length", () => {
            expect(() => decodeVaultKey("abcd")).toThrow(/32 bytes/);
            expect(() => decodeVaultKey(HEX_KEY.slice(0, 32))).toThrow(/32 bytes/);
        });
    });

    describe("a disabled vault", () => {
        const vault = createApiKeyVault("");

        it("stores nothing and refuses to decrypt", () => {
            expect(vault.enabled).toBe(false);
            expect(vault.encrypt("secret", "aad")).toBeNull();
            expect(() => vault.decrypt("v1.a.b.c", "aad")).toThrow(ApiKeyVaultError);
        });
    });

    describe("an enabled vault", () => {
        const vault = createApiKeyVault(HEX_KEY);

        it("round-trips a key under its hash", () => {
            const ciphertext = vault.encrypt("VzxpDgjf4Y-6P6DtvlDHqLngKmigPQvB", "hash-1");
            expect(ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
            expect(vault.decrypt(ciphertext!, "hash-1")).toBe("VzxpDgjf4Y-6P6DtvlDHqLngKmigPQvB");
        });

        it("never emits the same ciphertext twice for the same key", () => {
            expect(vault.encrypt("k", "h")).not.toBe(vault.encrypt("k", "h"));
        });

        it("refuses a ciphertext moved onto another row", () => {
            const ciphertext = vault.encrypt("k", "hash-of-row-a")!;
            expect(() => vault.decrypt(ciphertext, "hash-of-row-b")).toThrow(ApiKeyVaultError);
        });

        it("refuses a ciphertext under a different vault key", () => {
            const ciphertext = vault.encrypt("k", "h")!;
            expect(() => createApiKeyVault(OTHER_HEX_KEY).decrypt(ciphertext, "h")).toThrow(ApiKeyVaultError);
        });

        it("refuses a tampered body and a malformed string", () => {
            const [v, iv, tag, body] = vault.encrypt("k", "h")!.split(".");
            const flipped = body!.startsWith("A") ? `B${body!.slice(1)}` : `A${body!.slice(1)}`;
            expect(() => vault.decrypt([v, iv, tag, flipped].join("."), "h")).toThrow(ApiKeyVaultError);
            expect(() => vault.decrypt("not-a-ciphertext", "h")).toThrow(ApiKeyVaultError);
            expect(() => vault.decrypt("v2.a.b.c", "h")).toThrow(ApiKeyVaultError);
        });
    });
});

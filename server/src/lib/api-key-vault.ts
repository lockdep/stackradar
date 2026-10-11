import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config/index.js";

/**
 * Encrypted-at-rest copies of scanner API keys, so an admin can be shown the
 * current key again after the one-time reveal at creation.
 *
 * Authentication never touches this: `validateApiKey` still matches the
 * SHA-256 in `api_keys.key_hash`, and a row with no ciphertext (minted before
 * this existed, or with the vault switched off) authenticates exactly as it
 * always did — it just cannot be revealed, only rotated.
 *
 * AES-256-GCM under one server-side key (`API_KEY_ENCRYPTION_KEY`). The
 * row's `key_hash` is the additional authenticated data, so a ciphertext
 * moved onto another row fails to decrypt instead of revealing the wrong
 * cluster's key. What this buys over the hash alone: a database dump on its
 * own still yields no usable credential; it takes the dump *and* the server
 * environment. That is the trade the reveal feature makes, and why the
 * endpoint behind it is admin-only and audited.
 *
 * Wire format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url — the
 * version prefix is what lets a future key rotation or algorithm change be
 * decoded per row rather than all at once.
 */

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Decodes the operator-supplied key: 64 hex characters or the base64 of 32
 * bytes. Anything else is a boot-time error, not a first-reveal surprise.
 */
export function decodeVaultKey(raw: string): Buffer {
    const trimmed = raw.trim();
    const buf = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
    if (buf.length !== KEY_BYTES) {
        throw new Error(
            `API_KEY_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (64 hex characters, or base64 of 32 bytes); got ${buf.length}`,
        );
    }
    return buf;
}

export class ApiKeyVaultError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ApiKeyVaultError";
    }
}

export interface ApiKeyVault {
    /** False when no key is configured: nothing is stored, and reveal is refused. */
    readonly enabled: boolean;
    /** The ciphertext to store next to the hash, or null when disabled. */
    encrypt(plaintext: string, aad: string): string | null;
    /** Throws `ApiKeyVaultError` on a tampered, foreign or undecodable ciphertext. */
    decrypt(ciphertext: string, aad: string): string;
}

export function createApiKeyVault(rawKey: string): ApiKeyVault {
    const key = rawKey ? decodeVaultKey(rawKey) : null;

    return {
        enabled: key !== null,

        encrypt(plaintext, aad) {
            if (!key) return null;
            const iv = randomBytes(IV_BYTES);
            const cipher = createCipheriv(ALGORITHM, key, iv);
            cipher.setAAD(Buffer.from(aad, "utf8"));
            const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
            const tag = cipher.getAuthTag();
            return [VERSION, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
        },

        decrypt(ciphertext, aad) {
            if (!key) throw new ApiKeyVaultError("API key vault is not configured");
            const [version, ivPart, tagPart, bodyPart, ...rest] = ciphertext.split(".");
            if (version !== VERSION || !ivPart || !tagPart || !bodyPart || rest.length > 0) {
                throw new ApiKeyVaultError("Unrecognised API key ciphertext");
            }
            const iv = Buffer.from(ivPart, "base64url");
            const tag = Buffer.from(tagPart, "base64url");
            if (iv.length !== IV_BYTES || tag.length !== 16) {
                throw new ApiKeyVaultError("Unrecognised API key ciphertext");
            }
            try {
                const decipher = createDecipheriv(ALGORITHM, key, iv);
                decipher.setAAD(Buffer.from(aad, "utf8"));
                decipher.setAuthTag(tag);
                return Buffer.concat([decipher.update(Buffer.from(bodyPart, "base64url")), decipher.final()]).toString(
                    "utf8",
                );
            } catch {
                // GCM reports tampering, a wrong key and a wrong AAD identically,
                // and none of them is something to tell the caller apart.
                throw new ApiKeyVaultError("API key ciphertext failed to authenticate");
            }
        },
    };
}

/** The process-wide vault, keyed from the environment at boot. */
export const apiKeyVault = createApiKeyVault(config.apiKeys.encryptionKey);

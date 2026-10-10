import { randomBytes, createHash } from "crypto";

/**
 * The stored shape of a scanner API key: the SHA-256 the auth middleware
 * matches on, and the prefix the UI shows. One definition, used both when a
 * key is minted here and when one arrives from the environment
 * (`services/default-org.service.ts`, the community edition's bootstrap
 * key), so a key authenticates the same way whichever path stored it.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, 8);
}

/**
 * Generate a new API key
 * Format: 32 random base64url chars
 */
export function generateApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const key = randomBytes(24).toString("base64url"); // 32 chars
  return { key, keyPrefix: apiKeyPrefix(key), keyHash: hashApiKey(key) };
}

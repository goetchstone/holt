// /app/src/lib/secretCrypto.ts
//
// Application-level encryption for third-party integration secrets stored in
// the database (IntegrationCredential.ciphertext). Plaintext secrets are
// encrypted with AES-256-GCM using a 32-byte key derived from the deployment's
// APP_ENCRYPTION_KEY. The key never leaves the server and is never persisted;
// ciphertext is the only thing stored. Self-hosters set APP_ENCRYPTION_KEY once
// (e.g. `openssl rand -hex 32`) and keep it stable -- rotating it invalidates
// every stored credential.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
// scrypt salt baked into the derived key. Frozen by design: changing this string
// re-derives a different key and makes every already-stored credential
// undecryptable. The `.v1` suffix makes a future rotation a deliberate, migrated
// event rather than an accidental break. (The literal predates the Holt rename;
// left as-is precisely because it must never change.)
const KEY_SALT = "kariann.integration-credentials.v1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      "APP_ENCRYPTION_KEY is missing or too short. Set a strong value " +
        "(e.g. `openssl rand -hex 32`) before configuring integration credentials.",
    );
  }
  // scrypt accepts any passphrase and always yields a 32-byte key, so
  // self-hosters can paste an arbitrary random string without length rules.
  cachedKey = scryptSync(secret, KEY_SALT, 32);
  return cachedKey;
}

// base64( iv[12] | authTag[16] | ciphertext )
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  // Reject anything too short to even hold the IV + full GCM tag: a truncated
  // payload would otherwise yield a short tag and weaken the integrity check.
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Malformed ciphertext: shorter than IV + auth tag");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = buf.subarray(IV_BYTES + TAG_BYTES);
  // Pin the GCM tag to the full 16 bytes; the implicit default would accept a
  // shorter tag, which is exploitable for forgeries.
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function lastFour(plaintext: string): string {
  return plaintext.slice(-4);
}

// Test-only: clears the memoized key so a test can swap APP_ENCRYPTION_KEY.
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}

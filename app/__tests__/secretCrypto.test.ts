// /app/__tests__/secretCrypto.test.ts
import { encryptSecret, decryptSecret, lastFour, _resetKeyCacheForTests } from "@/lib/secretCrypto";

describe("secretCrypto", () => {
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY = "test-encryption-key-do-not-use-in-prod-0123456789";
    _resetKeyCacheForTests();
  });

  it("round-trips a secret without leaking plaintext into the ciphertext", () => {
    const plaintext = "sk_live_abc123XYZ";
    const ct = encryptSecret(plaintext);
    expect(ct).not.toContain(plaintext);
    expect(decryptSecret(ct)).toBe(plaintext);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    expect(encryptSecret("same-value")).not.toBe(encryptSecret("same-value"));
  });

  it("rejects tampered ciphertext via the GCM auth tag", () => {
    const ct = encryptSecret("secret");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0x01; // flip a byte in the encrypted region
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("lastFour returns the trailing four characters for masked display", () => {
    expect(lastFour("abcdef")).toBe("cdef");
  });

  it("throws a clear error when APP_ENCRYPTION_KEY is missing", () => {
    const prev = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    _resetKeyCacheForTests();
    expect(() => encryptSecret("x")).toThrow(/APP_ENCRYPTION_KEY/);
    process.env.APP_ENCRYPTION_KEY = prev;
    _resetKeyCacheForTests();
  });
});

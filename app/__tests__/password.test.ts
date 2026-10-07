// /app/__tests__/password.test.ts
//
// Pure tests for local-account password hashing.

import { scryptSync, randomBytes } from "crypto";

import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("hashPassword", () => {
  test("produces the documented scrypt$N$salt$key format", () => {
    const hash = hashPassword("hunter2hunter");
    const parts = hash.split("$");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("16384");
    // salt + key are non-empty base64
    expect(parts[2].length).toBeGreaterThan(0);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  test("uses a fresh random salt each call (no two hashes match)", () => {
    expect(hashPassword("samepassword")).not.toBe(hashPassword("samepassword"));
  });

  test("rejects passwords shorter than 12 characters", () => {
    expect(() => hashPassword("short")).toThrow(/at least 12/);
    expect(() => hashPassword("elevenchar!")).toThrow(/at least 12/); // 11 chars
    expect(() => hashPassword("")).toThrow();
  });

  test("accepts a password of exactly 12 characters", () => {
    expect(() => hashPassword("twelvechars!")).not.toThrow(); // 12 chars
  });
});

describe("verifyPassword", () => {
  test("accepts the correct password against a fresh hash", () => {
    const hash = hashPassword("s3cretPassphrase");
    expect(verifyPassword("s3cretPassphrase", hash)).toBe(true);
  });

  test("rejects the wrong password", () => {
    const hash = hashPassword("s3cretPassphrase");
    expect(verifyPassword("wrongPassphrase", hash)).toBe(false);
  });

  test("rejects null / empty / malformed stored values", () => {
    expect(verifyPassword("anything", null)).toBe(false);
    expect(verifyPassword("anything", undefined)).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(verifyPassword("anything", "scrypt$16384$onlythreeparts")).toBe(false);
    expect(verifyPassword("", hashPassword("realpassword"))).toBe(false);
  });

  // Cross-compatibility pin: this hash was produced by the SAME inline scrypt
  // algorithm used in scripts/create-admin.mjs (password "correct horse
  // battery"). If lib/auth/password.ts ever changes its format or parameters
  // incompatibly, this fails — flagging that the bootstrap script must change
  // in lockstep.
  test("verifies a hash produced by the create-admin bootstrap script format", () => {
    const scriptHash =
      "scrypt$16384$Q86Heu3S8n5FbXp28AZtZw==$jZpdiIgGShFgQ9NjioxQYDaA00dqIU6v9iDPYViUY4xf5+3RzPBmGY1zRp8tcYoluy/j7l5pwKfp7DgPkFnnsA==";
    expect(verifyPassword("correct horse battery", scriptHash)).toBe(true);
    expect(verifyPassword("wrong password", scriptHash)).toBe(false);
  });

  test("refuses an otherwise-valid hash whose stored cost is below the floor", () => {
    // Build a hash that WOULD verify -- correct key, correct format -- but at
    // N=1024, under the 16384 floor. The old check (n <= 1) accepted it; it must
    // now be refused for its weak cost, not the key.
    const salt = randomBytes(16);
    const key = scryptSync("correctpassword", salt, 64, { N: 1024, r: 8, p: 1 });
    const weakHash = `scrypt$1024$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(verifyPassword("correctpassword", weakHash)).toBe(false);
  });
});

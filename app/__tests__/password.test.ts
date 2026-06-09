// /app/__tests__/password.test.ts
//
// Pure tests for local-account password hashing.

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

  test("rejects passwords shorter than 8 characters", () => {
    expect(() => hashPassword("short")).toThrow(/at least 8/);
    expect(() => hashPassword("")).toThrow();
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
});

// /app/__tests__/secretsEqual.test.ts
//
// lib/auth/secretsEqual.ts is the one constant-time comparison for secrets a
// request presents (the scheduler's service key, the bookings feed token). The
// timing itself cannot be measured in a unit test; these pin its answers, so a
// rewrite cannot change who gets in.

import { secretsEqual } from "@/lib/auth/secretsEqual";

describe("secretsEqual", () => {
  it("matches the same secret", () => {
    expect(secretsEqual("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("refuses a different secret of the same length", () => {
    expect(secretsEqual("s3cret-tokeX", "s3cret-token")).toBe(false);
  });

  it("refuses a shorter or longer secret without throwing", () => {
    expect(secretsEqual("s3cret", "s3cret-token")).toBe(false);
    expect(secretsEqual("s3cret-token-and-more", "s3cret-token")).toBe(false);
    expect(secretsEqual("", "s3cret-token")).toBe(false);
  });

  it("never matches an empty expected secret, even an empty guess", () => {
    expect(secretsEqual("", "")).toBe(false);
    expect(secretsEqual("anything", "")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(secretsEqual("S3CRET-TOKEN", "s3cret-token")).toBe(false);
  });

  // The compare runs over the expected secret's length, so these are the cases
  // where cutting or zero-padding the guess could fool it; the length check
  // must refuse each one.
  it("refuses a guess that starts with the secret and runs on", () => {
    expect(secretsEqual("s3cret-token\u0000", "s3cret-token")).toBe(false);
    expect(secretsEqual("s3cret-token-extra", "s3cret-token")).toBe(false);
  });

  it("refuses a shorter guess even when the secret ends in zero bytes", () => {
    expect(secretsEqual("abc", "abc\u0000\u0000")).toBe(false);
  });

  it("compares multi-byte characters by their bytes", () => {
    expect(secretsEqual("clé-secrète", "clé-secrète")).toBe(true);
    expect(secretsEqual("cle-secrete", "clé-secrète")).toBe(false);
  });
});

// /app/__tests__/validateEnv.test.ts
//
// Pure tests for fail-fast env validation. The whole point is that a
// misconfigured prod deploy crashes at boot, so the rules here are the
// contract: which vars are required, the length floors, and the prod-only
// https NEXTAUTH_URL rule.

import { collectEnvProblems, assertEnv } from "@/lib/validateEnv";

const ok = {
  DATABASE_URL: "postgres://u:p@h:5432/db",
  NEXTAUTH_SECRET: "x".repeat(32),
  APP_ENCRYPTION_KEY: "y".repeat(32),
  NEXTAUTH_URL: "https://app.example.com",
} as unknown as NodeJS.ProcessEnv;

describe("collectEnvProblems", () => {
  it("passes a complete prod env", () => {
    expect(collectEnvProblems(ok, true)).toEqual([]);
  });

  it("flags each missing required secret", () => {
    const keys = collectEnvProblems({} as unknown as NodeJS.ProcessEnv, false).map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining(["DATABASE_URL", "NEXTAUTH_SECRET", "APP_ENCRYPTION_KEY"]),
    );
  });

  it("flags too-short secrets", () => {
    const keys = collectEnvProblems(
      { ...ok, NEXTAUTH_SECRET: "short", APP_ENCRYPTION_KEY: "tiny" },
      true,
    ).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["NEXTAUTH_SECRET", "APP_ENCRYPTION_KEY"]));
  });

  it("requires https NEXTAUTH_URL in production only", () => {
    const httpProd = collectEnvProblems({ ...ok, NEXTAUTH_URL: "http://x" }, true);
    expect(httpProd.some((p) => p.key === "NEXTAUTH_URL")).toBe(true);
    // Dev tolerates a missing / http URL.
    const dev = collectEnvProblems(
      { ...ok, NEXTAUTH_URL: undefined } as unknown as NodeJS.ProcessEnv,
      false,
    );
    expect(dev.some((p) => p.key === "NEXTAUTH_URL")).toBe(false);
  });

  describe("ALLOW_INSECURE_NEXTAUTH_URL", () => {
    // The escape hatch exists so a production BUILD can boot on localhost --
    // otherwise nothing ever verified that `next build` output actually
    // starts, which is a bigger hole than the one the https rule closes.
    const insecure = (url: string, allow: string | undefined) =>
      collectEnvProblems(
        { ...ok, NEXTAUTH_URL: url, ALLOW_INSECURE_NEXTAUTH_URL: allow } as unknown as NodeJS.ProcessEnv,
        true,
      ).some((p) => p.key === "NEXTAUTH_URL");

    it("permits http on localhost when explicitly enabled", () => {
      expect(insecure("http://localhost:3000", "true")).toBe(false);
      expect(insecure("http://127.0.0.1:3000", "true")).toBe(false);
    });

    it("still rejects http on a REMOTE host even when enabled", () => {
      // The point of the narrow scope: this must never become a way to turn
      // the check off in production.
      expect(insecure("http://app.example.com", "true")).toBe(true);
      expect(insecure("http://10.0.0.5:3000", "true")).toBe(true);
    });

    it("rejects http on localhost when NOT enabled", () => {
      expect(insecure("http://localhost:3000", undefined)).toBe(true);
    });

    it("does not relax the presence requirement", () => {
      expect(insecure("", "true")).toBe(true);
    });
  });

  it("assertEnv throws listing every problem, passes when clean", () => {
    expect(() => assertEnv({} as unknown as NodeJS.ProcessEnv)).toThrow(/Refusing to start/);
    expect(() => assertEnv(ok)).not.toThrow();
  });
});

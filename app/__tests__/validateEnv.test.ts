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

  it("assertEnv throws listing every problem, passes when clean", () => {
    expect(() => assertEnv({} as unknown as NodeJS.ProcessEnv)).toThrow(/Refusing to start/);
    expect(() => assertEnv(ok)).not.toThrow();
  });
});

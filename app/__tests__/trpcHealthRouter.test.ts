// /app/__tests__/trpcHealthRouter.test.ts
//
// Exercises the tRPC router via createCallerFactory with a fake context — no
// HTTP, no browser. Proves: public procedures run without auth; protected
// procedures reject an anonymous context and resolve the user id when present.
// This is the browser-free guard for the auth wiring (the live getToken path
// still needs a manual smoke test, noted in MIGRATION-PLAN.md).

import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";

const createCaller = createCallerFactory(appRouter);

function ctx(overrides: Partial<TrpcContext> = {}): TrpcContext {
  return {
    userId: null,
    userEmail: null,
    tokenRole: null,
    impersonate: null,
    headers: new Headers(),
    ...overrides,
  };
}

describe("tRPC health router", () => {
  test("public ping works without a session", async () => {
    const caller = createCaller(ctx());
    await expect(caller.health.ping()).resolves.toEqual({ ok: true });
  });

  test("protected me rejects an anonymous context", async () => {
    const caller = createCaller(ctx());
    await expect(caller.health.me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("protected me returns the user id when signed in", async () => {
    const caller = createCaller(ctx({ userId: "user-123" }));
    await expect(caller.health.me()).resolves.toEqual({ userId: "user-123" });
  });
});

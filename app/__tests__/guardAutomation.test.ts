// /app/__tests__/guardAutomation.test.ts
//
// SEC-02: the automation trigger routes used to accept "any authenticated
// session". guardAutomation replaces that with two ways in and only two -- the
// scheduler's service key, or the `admin.automations` permission. This pins the
// wiring: a valid key runs the job with no session and never touches the
// permission path; without the key the request goes through requirePermission
// with the automations key. Reintroducing a session-only branch breaks the
// "no key -> requirePermission" assertion.

import type { NextApiRequest, NextApiResponse } from "next";

const requirePermissionSpy = jest.fn((_permission: string, handler: unknown) =>
  // Return a recognizable wrapped handler so we can assert it was produced.
  Object.assign(
    (req: unknown, res: unknown) =>
      (handler as (a: unknown, b: unknown, c: unknown) => unknown)(req, res, {
        user: { email: "admin@store.com" },
      }),
    {
      __wrapped: true,
    },
  ),
);
jest.mock("@/lib/auth/requireAuth", () => ({
  requirePermission: (permission: string, handler: unknown) =>
    requirePermissionSpy(permission, handler),
}));

import { authorizedByAutoImportKey, guardAutomation } from "@/lib/automations/guardAutomation";

const req = (authorization?: string): NextApiRequest =>
  ({ headers: authorization ? { authorization } : {} }) as unknown as NextApiRequest;
const res = () => ({}) as unknown as NextApiResponse;

const OLD_ENV = process.env.AUTO_IMPORT_API_KEY;
afterEach(() => {
  process.env.AUTO_IMPORT_API_KEY = OLD_ENV;
  requirePermissionSpy.mockClear();
});

describe("authorizedByAutoImportKey", () => {
  it("accepts the exact Bearer service key", () => {
    process.env.AUTO_IMPORT_API_KEY = "s3cr3t";
    expect(authorizedByAutoImportKey(req("Bearer s3cr3t"))).toBe(true);
  });
  it("rejects a wrong or missing token", () => {
    process.env.AUTO_IMPORT_API_KEY = "s3cr3t";
    expect(authorizedByAutoImportKey(req("Bearer nope"))).toBe(false);
    expect(authorizedByAutoImportKey(req())).toBe(false);
  });
  it("rejects everything when no key is configured (an empty key is not a wildcard)", () => {
    delete process.env.AUTO_IMPORT_API_KEY;
    expect(authorizedByAutoImportKey(req("Bearer "))).toBe(false);
    expect(authorizedByAutoImportKey(req())).toBe(false);
  });
});

describe("guardAutomation", () => {
  it("with the service key: runs the job directly with a null session, no permission check", async () => {
    process.env.AUTO_IMPORT_API_KEY = "s3cr3t";
    const run = jest.fn(async (_req?: unknown, _res?: unknown, _session?: unknown) => undefined);
    await guardAutomation(run)(req("Bearer s3cr3t"), res());
    expect(run).toHaveBeenCalledTimes(1);
    // The scheduler has no session.
    expect(run.mock.calls[0][2]).toBeNull();
    expect(requirePermissionSpy).not.toHaveBeenCalled();
  });

  it("without the service key: goes through requirePermission('admin.automations')", async () => {
    process.env.AUTO_IMPORT_API_KEY = "s3cr3t";
    const run = jest.fn(async (_req?: unknown, _res?: unknown, _session?: unknown) => undefined);
    await guardAutomation(run)(req("Bearer wrong"), res());
    expect(requirePermissionSpy).toHaveBeenCalledTimes(1);
    expect(requirePermissionSpy.mock.calls[0][0]).toBe("admin.automations");
    // The run is invoked through the permission wrapper (which supplies the session).
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toEqual({ user: { email: "admin@store.com" } });
  });

  it("with no key configured: still requires the permission (no session-only bypass)", async () => {
    delete process.env.AUTO_IMPORT_API_KEY;
    const run = jest.fn(async (_req?: unknown, _res?: unknown, _session?: unknown) => undefined);
    await guardAutomation(run)(req(), res());
    expect(requirePermissionSpy).toHaveBeenCalledTimes(1);
    expect(requirePermissionSpy.mock.calls[0][0]).toBe("admin.automations");
  });
});

// /app/__tests__/requirePermissionAnyOf.test.ts
//
// PLACEHOLDER TEST — Grade: A (wrap-time validation only, no SQL behavior)
//
// Prisma, next-auth and the auth options are stubbed only so requireAuth can
// be imported; nothing here reaches them. What is under test is the check
// requirePermission makes before it returns a handler.
//
// requirePermission({ anyOf: [] }) would admit nobody but the bootstrap
// safeguard -- a typo in code, not a policy. It is refused when the route
// module loads, so it fails the build's first import instead of 403-ing staff.
// The decision itself (any key admits, one staff read) is covered in
// permissionDecision.test.ts and permissionResolver.test.ts.

jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("@/pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("@/lib/prisma", () => ({ prisma: {} }));

import { requirePermission } from "@/lib/auth/requireAuth";

const handler = jest.fn();

describe("requirePermission accepts one key or a non-empty { anyOf }", () => {
  it("wraps a single key", () => {
    expect(typeof requirePermission("sales.read", handler)).toBe("function");
  });

  it("wraps an { anyOf } list", () => {
    expect(typeof requirePermission({ anyOf: ["sales.read", "reporting.read"] }, handler)).toBe(
      "function",
    );
  });

  it("refuses an empty { anyOf } list when the route loads", () => {
    expect(() => requirePermission({ anyOf: [] }, handler)).toThrow(/at least one permission key/);
  });
});

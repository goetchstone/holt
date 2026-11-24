// /app/__tests__/impersonateGate.test.ts
//
// Who may View as is one rule, IMPERSONATE in lib/auth/roleDecision.ts, which
// every gate applies to the holt-impersonate cookie and useEffectiveRole applies
// to the menu and the banner. The endpoint that sets and clears the cookie
// writes the requirement out as a literal, because permissionKeysExist.test.ts
// reads only literal keys at a requirePermission call. This pins that literal
// to the rule by loading the real route and reading what it handed its gate,
// so the endpoint and the gates cannot disagree about who may View as.

jest.mock("@/lib/auth/requireAuth", () => ({
  requirePermission: jest.fn((_permission: unknown, handler: unknown) => handler),
}));
jest.mock("@/lib/audit", () => ({ auditActor: jest.fn(), auditLog: jest.fn() }));

import { requirePermission } from "@/lib/auth/requireAuth";
import { IMPERSONATE } from "@/lib/auth/roleDecision";
import "@/pages/api/admin/impersonate";

describe("POST /api/admin/impersonate", () => {
  it("is gated on exactly IMPERSONATE, the rule every gate applies to the cookie", () => {
    const calls = (requirePermission as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(IMPERSONATE);
  });
});

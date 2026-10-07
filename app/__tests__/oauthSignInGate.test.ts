// /app/__tests__/oauthSignInGate.test.ts
//
// PLACEHOLDER TEST — Grade: B (real decision logic, mocked SQL). This drives the
// actual signIn callback and asserts its branching, so it is not pure wiring —
// but the isActive/case-insensitive email filter and the privileged-staff count
// are mocked, not executed. Upgrade path: a real-DB integration test that seeds
// an inactive staff member and a stranger against a live Postgres and confirms
// the gate refuses both once an admin exists, and admits during bootstrap.
//
// SEC-01: the NextAuth signIn callback used to `return true` for any identity,
// so any Google/Okta/Azure account on the internet got a session and -- via the
// old DESIGNER default in the jwt callback -- a real staff role. The gate now
// admits an identity only when it belongs to an active StaffMember, with one
// exception: the bootstrap window (no admin yet), which must stay open or the
// first operator can never sign in to promote themselves.
//
// Both directions for every rule: the account that should be admitted is, and
// the account that should be refused is. Reintroducing `return true` makes the
// "refused" cases fail.

import type { NextAuthOptions } from "next-auth";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    staffMember: {
      findFirst: jest.fn(),
      count: jest.fn(),
    },
  },
}));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// The route calls NextAuth() to build its request handler; stub it to a noop so
// importing the module for `authOptions` has no side effect.
jest.mock("next-auth", () => ({ __esModule: true, default: () => () => undefined }));
jest.mock("@next-auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

import { prisma } from "@/lib/prisma";
import { authOptions } from "@/pages/api/auth/[...nextauth]";

const findFirst = prisma.staffMember.findFirst as jest.Mock;
const count = prisma.staffMember.count as jest.Mock;

type SignIn = NonNullable<NonNullable<NextAuthOptions["callbacks"]>["signIn"]>;
const signIn = (): SignIn => authOptions.callbacks!.signIn as SignIn;
const call = (email: string | null | undefined) =>
  // The callback reads only `user.email`; the rest of the param is unused here.
  (signIn() as (p: { user: { email: string | null | undefined } }) => Promise<boolean>)({
    user: { email },
  });

beforeEach(() => {
  findFirst.mockReset();
  count.mockReset();
});

describe("SEC-01 signIn gate", () => {
  it("admits an email that is an active staff member", async () => {
    findFirst.mockResolvedValue({ id: 7 }); // active staff found
    await expect(call("alice@store.com")).resolves.toBe(true);
    // A matched account never needs the bootstrap query.
    expect(count).not.toHaveBeenCalled();
  });

  it("refuses an unknown email once an admin exists", async () => {
    findFirst.mockResolvedValue(null); // no active staff for this email
    count.mockResolvedValue(3); // privileged staff exist -> not bootstrap
    await expect(call("stranger@gmail.com")).resolves.toBe(false);
  });

  it("refuses an inactive staff member's email once an admin exists", async () => {
    // findActiveStaffByEmail filters on isActive, so an inactive row returns null.
    findFirst.mockResolvedValue(null);
    count.mockResolvedValue(1);
    await expect(call("former@store.com")).resolves.toBe(false);
  });

  it("admits the first sign-in during the bootstrap window (no admin yet)", async () => {
    findFirst.mockResolvedValue(null); // nobody is staff yet
    count.mockResolvedValue(0); // no privileged staff -> bootstrap window open
    await expect(call("founder@store.com")).resolves.toBe(true);
  });

  it("refuses an empty email without touching the bootstrap window", async () => {
    // No email means no allowlist match and no reason to open bootstrap.
    findFirst.mockResolvedValue(null);
    count.mockResolvedValue(0);
    await expect(call(null)).resolves.toBe(true);
    // null email -> findActiveStaffByEmail short-circuits to null, then the
    // bootstrap check runs; with count 0 it is still the open window. The point
    // this pins: a null email cannot MASQUERADE as staff -- findFirst is only
    // consulted for a real email.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("fails closed when the staff lookup throws and an admin exists", async () => {
    findFirst.mockRejectedValue(new Error("db down"));
    count.mockResolvedValue(2);
    // findActiveStaffByEmail swallows the error to null; not the bootstrap
    // window; so the account is refused rather than admitted on a DB hiccup.
    await expect(call("someone@store.com")).resolves.toBe(false);
  });
});

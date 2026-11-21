// /app/__tests__/diagnosticsLookupTest.test.ts
//
// POST /api/diagnostics/lookup-test answered a database failure with a 500
// whose body carried the database's own message ("An unexpected database error
// occurred: <it>"), and logged nothing, so the response was the only record
// (rule 11). The 500-body tripwire (api500Bodies.test.ts) could not see it: the
// body is a result object, and the message was written into one of its fields.
// This drives the route with the lookup failing.
//
// PLACEHOLDER TEST — Grade: B (the real route's catch; Prisma stood in for only to
// throw). No SQL is under test: what is checked is the 500's body and the log when
// a query throws, which a real database won't do on demand, so no real-DB version
// is planned.

import type { NextApiRequest, NextApiResponse } from "next";

const findFirst = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: { upc: { findFirst: (...a: unknown[]) => findFirst(...a) }, product: { findFirst } },
}));
jest.mock("@/lib/auth/requireAuth", () => ({
  // Bypass the role gate; the gates are covered by the apiRouteAuthorization tripwire.
  requireAuthWithRole:
    (_roles: unknown, handler: (...a: unknown[]) => unknown) => (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "manager@example.com" } }, { holds: {} }),
}));
const logError = jest.fn();
jest.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));

import lookupTest from "@/pages/api/diagnostics/lookup-test";

async function post(body: unknown) {
  const sent = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(value: unknown) {
      sent.body = value;
      return res;
    },
  };
  await lookupTest(
    { method: "POST", body } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return sent;
}

describe("POST /api/diagnostics/lookup-test when the database fails", () => {
  const failure = new Error(
    "Invalid `prisma.upc.findFirst()` invocation: The column `Upc.secret` does not exist.",
  );

  it("answers what failed, and logs why", async () => {
    findFirst.mockRejectedValueOnce(failure);

    const sent = await post({ identifier: "0123456789" });

    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ error: "An unexpected database error occurred." });
    expect(JSON.stringify(sent.body)).not.toMatch(/prisma|Upc\.secret|invocation/);
    expect(logError).toHaveBeenCalledWith("Lookup test failed", failure, {
      searchType: "UPC (Case-Insensitive)",
    });
  });
});

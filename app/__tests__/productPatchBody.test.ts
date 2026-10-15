// /app/__tests__/productPatchBody.test.ts
//
// PLACEHOLDER TEST — Grade: B- (mocked Prisma records the call; no SQL)
// The property under test is decided before any query runs, so the mock only
// has to say whether update() was reached. Upgrade path: a real-DB PATCH test
// under __tests__/integration/ if this route grows SQL-dependent behaviour.
//
// PATCH /api/products/[id] destructures `length` (the product dimension) from
// the body. On an array or string body that is the BODY's length, so a PATCH
// of `[1,2,3]` wrote length = 3 to the product (CodeQL
// js/type-confusion-through-parameter-tampering #18). The route now refuses a
// body that is not a JSON object before touching the database.
//
// Prisma is mocked: the property under test is whether update() is reached and
// with what, not Prisma's own behaviour. Auth is bypassed; the gate itself is
// covered by apiRouteAuthorization.test.ts.

import type { NextApiRequest, NextApiResponse } from "next";

const update = jest.fn();

jest.mock("@/lib/prisma", () => ({
  prisma: { product: { update: (...args: unknown[]) => update(...args) } },
}));

jest.mock("@/lib/auth/requireAuth", () => ({
  requirePermission:
    (_permission: string, handler: (...a: unknown[]) => unknown) => (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "catalog@example.com" } }),
}));

import handler from "@/pages/api/products/[id]";

function makeRes() {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; payload: unknown };
}

function patch(body: unknown): NextApiRequest {
  return { method: "PATCH", query: { id: "7" }, body } as unknown as NextApiRequest;
}

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue({ id: 7 });
});

describe("PATCH /api/products/[id] body shape", () => {
  it.each([
    ["an array", [1, 2, 3]],
    ["a string", "abc"],
    ["null", null],
  ])("refuses %s body without writing", async (_label, body) => {
    const res = makeRes();
    await handler(patch(body), res);
    expect(res.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("applies a JSON object body, reading length as the product field", async () => {
    const res = makeRes();
    await handler(patch({ length: "12.5", serviceType: "DELIVERY" }), res);
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toMatchObject({ length: 12.5, serviceType: "DELIVERY" });
  });
});

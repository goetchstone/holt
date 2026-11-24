// /app/__tests__/errorCode.test.ts
//
// isWriteConflict: the errors that mean "someone else wrote the same rows at the
// same time; try again", which a route answers with a 409 rather than a 500
// (rule 11). The pg driver adapter turns a Postgres deadlock (40P01) or
// serialization failure (40001) into Prisma's P2034; a raw query's failure can
// still carry the Postgres code in its meta. A real deadlock through the staff
// route is in integration/staffSignInIdentity.integration.test.ts.

import { getErrorCode, isWriteConflict } from "@/lib/errorCode";

describe("isWriteConflict", () => {
  it("is true for Prisma's write conflict and for the Postgres codes beneath it", () => {
    expect(isWriteConflict({ code: "P2034" })).toBe(true);
    expect(isWriteConflict({ code: "P2010", meta: { code: "40P01" } })).toBe(true);
    expect(isWriteConflict({ code: "P2010", meta: { code: "40001" } })).toBe(true);
    expect(
      isWriteConflict({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
      }),
    ).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isWriteConflict({ code: "P2002" })).toBe(false);
    expect(isWriteConflict({ code: "P2010", meta: { code: "23505" } })).toBe(false);
    expect(isWriteConflict(new Error("boom"))).toBe(false);
    expect(isWriteConflict(null)).toBe(false);
    expect(isWriteConflict("P2034")).toBe(false);
  });

  it("leaves getErrorCode as it was", () => {
    expect(getErrorCode({ code: "P2002" })).toBe("P2002");
    expect(getErrorCode({})).toBeUndefined();
  });
});

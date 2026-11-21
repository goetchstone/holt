// /app/__tests__/portalReturnRequest.test.ts
//
// The customer's return request (POST /api/portal/returns/request) is public:
// the Return's portalToken is the only credential. Its body is checked here,
// before anything reaches Prisma (lib/returns/portalReturn.ts). An unknown
// reason used to reach the ReturnReason enum column and come back as a 500;
// it is now a 400 that names the reasons there are.
//
// What the route answers is the same projection the portal pages read, never
// the Return row. The line check needs the database and is in
// integration/portalReturnRequest.integration.test.ts.

import { Prisma, ReturnReason } from "@prisma/client";
import {
  PORTAL_RETURN_SELECT,
  parsePortalReturnRequest,
  toPortalReturn,
} from "@/lib/returns/portalReturn";

const ok = (body: unknown) => {
  const parsed = parsePortalReturnRequest(body);
  if (!parsed.ok) throw new Error(`expected ok, got: ${parsed.error}`);
  return parsed.value;
};
const refused = (body: unknown) => {
  const parsed = parsePortalReturnRequest(body);
  if (parsed.ok) throw new Error(`expected a refusal, got: ${JSON.stringify(parsed.value)}`);
  return parsed.error;
};

describe("parsePortalReturnRequest", () => {
  it("takes a token and a reason; the line and the notes are optional", () => {
    expect(ok({ portalToken: "tok", reason: "DEFECTIVE" })).toEqual({
      portalToken: "tok",
      reason: "DEFECTIVE",
      reasonNotes: null,
      lineItemId: null,
    });
    expect(
      ok({ portalToken: "tok", reason: "OTHER", reasonNotes: "Scratched leg", lineItemId: 7 }),
    ).toEqual({ portalToken: "tok", reason: "OTHER", reasonNotes: "Scratched leg", lineItemId: 7 });
  });

  it("accepts every ReturnReason", () => {
    for (const reason of Object.values(ReturnReason)) {
      expect(ok({ portalToken: "tok", reason }).reason).toBe(reason);
    }
  });

  it.each([["NOT_A_REASON"], ["defective"], ["__proto__"], ["constructor"], ["toString"]])(
    "refuses the reason %j and names the reasons there are",
    (reason) => {
      const error = refused({ portalToken: "tok", reason });
      expect(error).toMatch(/^reason must be one of /);
      for (const known of Object.values(ReturnReason)) expect(error).toContain(known);
    },
  );

  it("keeps the messages a missing token or reason always had", () => {
    expect(refused({ reason: "OTHER" })).toBe("portalToken is required");
    expect(refused({ portalToken: 5, reason: "OTHER" })).toBe("portalToken is required");
    expect(refused({ portalToken: "tok" })).toBe("reason is required");
    expect(refused({ portalToken: "tok", reason: 3 })).toBe("reason is required");
    expect(refused(null)).toBe("portalToken is required");
    expect(refused("portalToken=tok")).toBe("portalToken is required");
  });

  it.each([["7"], [0], [-1], [1.5], [true], [{}]])("refuses the line id %j", (lineItemId) => {
    expect(refused({ portalToken: "tok", reason: "OTHER", lineItemId })).toBe(
      "lineItemId must be a whole number above zero",
    );
  });

  it("reads an absent line as none", () => {
    expect(ok({ portalToken: "tok", reason: "OTHER", lineItemId: null }).lineItemId).toBeNull();
  });

  it("keeps notes as text, an empty note as none, and refuses notes that are not text", () => {
    expect(ok({ portalToken: "tok", reason: "OTHER", reasonNotes: "" }).reasonNotes).toBeNull();
    expect(refused({ portalToken: "tok", reason: "OTHER", reasonNotes: { a: 1 } })).toBe(
      "reasonNotes must be text",
    );
  });
});

describe("toPortalReturn", () => {
  const row = {
    returnNumber: "RET-261121-001",
    status: "INITIATED" as const,
    reason: "DEFECTIVE" as const,
    productName: "Camelback Sofa",
    quantity: new Prisma.Decimal("2.5"),
    created: new Date("2026-11-21T15:00:00Z"),
    customerNotes: "Torn seam",
  };

  it("is exactly the fields the portal pages read, as JSON-ready values", () => {
    expect(toPortalReturn(row)).toEqual({
      returnNumber: "RET-261121-001",
      status: "INITIATED",
      reason: "DEFECTIVE",
      productName: "Camelback Sofa",
      quantity: 2.5,
      created: "2026-11-21T15:00:00.000Z",
      customerNotes: "Torn seam",
    });
  });

  it("selects nothing it does not send", () => {
    expect(Object.keys(PORTAL_RETURN_SELECT).sort()).toEqual(
      Object.keys(toPortalReturn(row)).sort(),
    );
  });
});

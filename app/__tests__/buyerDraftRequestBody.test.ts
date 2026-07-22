// /app/__tests__/buyerDraftRequestBody.test.ts
//
// A-grade unit tests for `lib/buyerDraftRequestBody.ts`. Pure helpers — no DB,
// no I/O. Covers every branch in the body-coercion path so a typo in the
// validation logic (e.g. forgetting to reject negative qty, accepting an
// unknown enum, silently dropping a string field) fails red.

import {
  // primitives
  stringOrEmpty,
  optionalString,
  optionalInt,
  numberOrZero,
  optionalDecimal,
  decimalOrThrow,
  optionalJson,
  optionalDate,
  pickEnum,
  connectOrDisconnect,
  validatedQty,
  // build* aggregates
  buildItemCreateData,
  buildItemUpdateData,
  buildPoCreateData,
  buildPoUpdateData,
  // enum lists
  VALID_ITEM_STATUSES,
  VALID_PO_STATUSES,
  VALID_SOURCES,
  // apply* helpers (each tested directly so a future refactor doesn't break the contract)
  applyItemFkPatches,
  applyItemTextPatches,
  applyItemNumericPatches,
  applyItemFlagPatches,
  applyItemEnumPatches,
  // slice 4a — assemble description from structured fields
  assembleDescription,
  assembleDescriptionForExport,
  CLEANING_CODE_PRESETS,
} from "@/lib/buyerDraftRequestBody";
import { Prisma } from "@prisma/client";

// ─── Primitives ────────────────────────────────────────────────────────

describe("stringOrEmpty", () => {
  it("trims a string", () => expect(stringOrEmpty("  hi  ")).toBe("hi"));
  it("returns empty for non-string", () => expect(stringOrEmpty(42)).toBe(""));
  it("returns empty for null", () => expect(stringOrEmpty(null)).toBe(""));
  it("returns empty for undefined", () => expect(stringOrEmpty(undefined)).toBe(""));
});

describe("optionalString", () => {
  it("trims a string", () => expect(optionalString("  hi  ")).toBe("hi"));
  it("returns null for empty string", () => expect(optionalString("")).toBeNull());
  it("returns null for whitespace-only string", () => expect(optionalString("   ")).toBeNull());
  it("returns null for non-string", () => expect(optionalString(42)).toBeNull());
  it("returns null for null", () => expect(optionalString(null)).toBeNull());
});

describe("optionalInt", () => {
  it("returns int from number", () => expect(optionalInt(42)).toBe(42));
  it("returns int from numeric string", () => expect(optionalInt("42")).toBe(42));
  it("returns null for empty string", () => expect(optionalInt("")).toBeNull());
  it("returns null for null", () => expect(optionalInt(null)).toBeNull());
  it("returns null for undefined", () => expect(optionalInt(undefined)).toBeNull());
  it("returns null for non-integer", () => expect(optionalInt(3.5)).toBeNull());
  it("returns null for non-numeric string", () => expect(optionalInt("abc")).toBeNull());
  it("returns 0 for '0' (genuine zero)", () => expect(optionalInt("0")).toBe(0));
});

describe("numberOrZero", () => {
  it("returns finite number", () => expect(numberOrZero(3.14)).toBe(3.14));
  it("returns 0 for empty string", () => expect(numberOrZero("")).toBe(0));
  it("returns 0 for null", () => expect(numberOrZero(null)).toBe(0));
  it("returns 0 for undefined", () => expect(numberOrZero(undefined)).toBe(0));
  it("returns 0 for non-numeric string", () => expect(numberOrZero("abc")).toBe(0));
  it("returns 0 for Infinity", () => expect(numberOrZero(Infinity)).toBe(0));
  it("returns 0 for NaN", () => expect(numberOrZero(NaN)).toBe(0));
});

describe("optionalDecimal", () => {
  it("returns Decimal for finite number", () => {
    const d = optionalDecimal(1275.5);
    expect(d).toBeInstanceOf(Prisma.Decimal);
    expect(d!.toString()).toBe("1275.5");
  });
  it("returns null for empty string", () => expect(optionalDecimal("")).toBeNull());
  it("returns null for null", () => expect(optionalDecimal(null)).toBeNull());
  it("returns null for non-numeric string", () => expect(optionalDecimal("abc")).toBeNull());
  it("returns null for Infinity", () => expect(optionalDecimal(Infinity)).toBeNull());
  it("returns null for NaN", () => expect(optionalDecimal(NaN)).toBeNull());
});

describe("decimalOrThrow", () => {
  it("returns Decimal for finite number", () => {
    expect(decimalOrThrow(99, "cost")!.toString()).toBe("99");
  });
  it("returns Decimal for numeric string", () => {
    expect(decimalOrThrow("99.50", "cost")!.toString()).toBe("99.5");
  });
  it("throws TypeError if value is null", () => {
    expect(() => decimalOrThrow(null, "cost")).toThrow(TypeError);
    expect(() => decimalOrThrow(null, "cost")).toThrow(/cost is required/);
  });
  it("throws TypeError if value is empty string", () => {
    expect(() => decimalOrThrow("", "retail")).toThrow(/retail is required/);
  });
  it("throws TypeError if value is non-finite", () => {
    expect(() => decimalOrThrow("abc", "cost")).toThrow(/cost must be a finite number/);
    expect(() => decimalOrThrow(Infinity, "cost")).toThrow(/finite/);
    expect(() => decimalOrThrow(NaN, "cost")).toThrow(/finite/);
  });
});

describe("optionalJson", () => {
  it("passes through an object", () => {
    expect(optionalJson({ foo: "bar" })).toEqual({ foo: "bar" });
  });
  it("passes through an array", () => {
    expect(optionalJson([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("returns undefined for null (don't touch)", () => {
    expect(optionalJson(null)).toBeUndefined();
  });
  it("returns undefined for undefined (don't touch)", () => {
    expect(optionalJson(undefined)).toBeUndefined();
  });
});

describe("optionalDate", () => {
  it("returns Date from ISO string", () => {
    const d = optionalDate("2026-05-08T12:00:00Z");
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe("2026-05-08T12:00:00.000Z");
  });
  it("returns Date from a Date object", () => {
    const input = new Date("2026-01-01");
    expect(optionalDate(input)).toBe(input);
  });
  it("returns null for invalid Date object", () => {
    expect(optionalDate(new Date("not a date"))).toBeNull();
  });
  it("returns null for empty string", () => expect(optionalDate("")).toBeNull());
  it("returns null for null", () => expect(optionalDate(null)).toBeNull());
  it("returns null for unparseable string", () => expect(optionalDate("garbage")).toBeNull());
  it("returns null for non-string non-Date input", () => expect(optionalDate(42)).toBeNull());
});

describe("pickEnum", () => {
  const valid = ["DRAFT", "READY"] as const;
  it("returns the value when valid", () => expect(pickEnum("READY", valid, "DRAFT")).toBe("READY"));
  it("returns fallback when invalid", () =>
    expect(pickEnum("WRONG", valid, "DRAFT")).toBe("DRAFT"));
  it("returns fallback when missing", () => expect(pickEnum(null, valid, "DRAFT")).toBe("DRAFT"));
  it("returns fallback when wrong type", () => expect(pickEnum(42, valid, "DRAFT")).toBe("DRAFT"));
});

describe("connectOrDisconnect", () => {
  it("connects to a positive integer id", () =>
    expect(connectOrDisconnect(42)).toEqual({ connect: { id: 42 } }));
  it("connects to a numeric-string id", () =>
    expect(connectOrDisconnect("42")).toEqual({ connect: { id: 42 } }));
  it("disconnects on null", () => expect(connectOrDisconnect(null)).toEqual({ disconnect: true }));
  it("disconnects on undefined", () =>
    expect(connectOrDisconnect(undefined)).toEqual({ disconnect: true }));
  it("disconnects on empty string", () =>
    expect(connectOrDisconnect("")).toEqual({ disconnect: true }));
  it("disconnects on non-integer (float)", () =>
    expect(connectOrDisconnect(3.5)).toEqual({ disconnect: true }));
  it("disconnects on non-numeric string", () =>
    expect(connectOrDisconnect("abc")).toEqual({ disconnect: true }));
});

describe("validatedQty", () => {
  it("accepts 0", () => expect(validatedQty(0)).toBe(0));
  it("accepts a positive integer", () => expect(validatedQty(6)).toBe(6));
  it("accepts a numeric string", () => expect(validatedQty("12")).toBe(12));
  it("throws on negative", () => {
    expect(() => validatedQty(-1)).toThrow(TypeError);
    expect(() => validatedQty(-1)).toThrow(/non-negative/);
  });
  it("throws on float", () => expect(() => validatedQty(3.5)).toThrow(/non-negative/));
  it("throws on non-numeric string", () =>
    expect(() => validatedQty("abc")).toThrow(/non-negative/));
});

// ─── Enum constants ────────────────────────────────────────────────────

describe("enum constants", () => {
  it("VALID_ITEM_STATUSES covers all 5 BuyerDraftItemStatus values", () => {
    expect(VALID_ITEM_STATUSES).toEqual(["DRAFT", "READY", "EXPORTED", "FULFILLED", "CANCELLED"]);
  });
  it("VALID_PO_STATUSES covers all 5 BuyerDraftPoStatus values", () => {
    expect(VALID_PO_STATUSES).toEqual(["DRAFT", "READY", "EXPORTED", "FULFILLED", "CANCELLED"]);
  });
  it("VALID_SOURCES covers the client-postable BuyerDraftSource values (HISTORICAL_PO_IMPORT excluded — set via a direct Prisma create, not this endpoint)", () => {
    expect(VALID_SOURCES).toEqual([
      "MANUAL",
      "HD_PROPOSAL",
      "APPAREL_SCAN",
      "CONFIGURATOR",
      "HOME_ACCESSORY_ORDER_IMPORT",
    ]);
  });
});

// ─── BuyerDraftItem create ─────────────────────────────────────────────

describe("buildItemCreateData", () => {
  const minimal = {
    vendorName: "V",
    partNumber: "P1",
    productName: "Test",
    cost: 100,
    retail: 250,
  };

  it("builds a minimum-viable create payload with sensible defaults", () => {
    const data = buildItemCreateData(minimal, "alice");
    expect(data.vendorName).toBe("V");
    expect(data.partNumber).toBe("P1");
    expect(data.productName).toBe("Test");
    expect(data.cost.toString()).toBe("100");
    expect(data.retail.toString()).toBe("250");
    expect(data.qty).toBe(1);
    expect(data.stockProgram).toBe(false);
    expect(data.source).toBe("MANUAL");
    expect(data.status).toBeUndefined(); // Prisma default ("DRAFT") applies
    expect(data.createdBy).toBe("alice");
    expect(data.msrp).toBeNull();
    expect(data.barcode).toBeNull();
  });

  it("trims required string fields", () => {
    const data = buildItemCreateData(
      { ...minimal, vendorName: "  V  ", partNumber: "  P  ", productName: "  N  " },
      null,
    );
    expect(data.vendorName).toBe("V");
    expect(data.partNumber).toBe("P");
    expect(data.productName).toBe("N");
  });

  it("throws on missing vendorName", () => {
    expect(() => buildItemCreateData({ ...minimal, vendorName: "" }, null)).toThrow(
      /vendorName is required/,
    );
  });
  it("throws on missing partNumber", () => {
    expect(() => buildItemCreateData({ ...minimal, partNumber: "   " }, null)).toThrow(
      /partNumber is required/,
    );
  });
  it("throws on missing productName", () => {
    expect(() => buildItemCreateData({ ...minimal, productName: undefined }, null)).toThrow(
      /productName is required/,
    );
  });

  it("coerces non-numeric cost / retail to 0 (KISS — don't throw on a sloppy number)", () => {
    const data = buildItemCreateData({ ...minimal, cost: "abc", retail: null }, null);
    expect(data.cost.toString()).toBe("0");
    expect(data.retail.toString()).toBe("0");
  });

  it("respects qty when set, defaults to 1 otherwise", () => {
    expect(buildItemCreateData({ ...minimal, qty: 5 }, null).qty).toBe(5);
    expect(buildItemCreateData({ ...minimal, qty: 0 }, null).qty).toBe(0);
    expect(buildItemCreateData({ ...minimal, qty: undefined }, null).qty).toBe(1);
    expect(buildItemCreateData({ ...minimal, qty: "abc" }, null).qty).toBe(1); // non-int falls back
  });

  it("captures barcode when provided (apparel scan path)", () => {
    const data = buildItemCreateData({ ...minimal, barcode: "012345678905" }, null);
    expect(data.barcode).toBe("012345678905");
  });

  it("captures stockFamily and stockProgram together", () => {
    const data = buildItemCreateData(
      { ...minimal, stockProgram: true, stockFamily: "WH Bevel Arm" },
      null,
    );
    expect(data.stockProgram).toBe(true);
    expect(data.stockFamily).toBe("WH Bevel Arm");
  });

  it("falls back to MANUAL on unknown source", () => {
    const data = buildItemCreateData({ ...minimal, source: "WRONG" }, null);
    expect(data.source).toBe("MANUAL");
  });

  it("preserves a recognized source", () => {
    expect(buildItemCreateData({ ...minimal, source: "APPAREL_SCAN" }, null).source).toBe(
      "APPAREL_SCAN",
    );
  });

  it("captures dimensions when provided", () => {
    const data = buildItemCreateData(
      { ...minimal, productWidth: 30, productLength: 39.5, productHeight: 34 },
      null,
    );
    expect(data.productWidth!.toString()).toBe("30");
    expect(data.productLength!.toString()).toBe("39.5");
    expect(data.productHeight!.toString()).toBe("34");
  });

  it("leaves dimensions null when absent or empty", () => {
    const data = buildItemCreateData({ ...minimal, productWidth: "" }, null);
    expect(data.productWidth).toBeNull();
    expect(data.productLength).toBeNull();
    expect(data.productHeight).toBeNull();
  });

  it("captures FK ids when provided", () => {
    const data = buildItemCreateData(
      { ...minimal, vendorId: 1, departmentId: 2, categoryId: 3, typeId: 4 },
      null,
    );
    expect(data.vendorId).toBe(1);
    expect(data.departmentId).toBe(2);
    expect(data.categoryId).toBe(3);
    expect(data.typeId).toBe(4);
  });

  it("preserves configuration JSON blob", () => {
    const data = buildItemCreateData(
      { ...minimal, configuration: { fabric: "Calvin Sky", grade: 16 } },
      null,
    );
    expect(data.configuration).toEqual({ fabric: "Calvin Sky", grade: 16 });
  });
});

// ─── BuyerDraftItem update — the apply* helpers ───────────────────────

describe("applyItemFkPatches", () => {
  it("connects when an integer id is given", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFkPatches({ vendorId: 42 }, data);
    expect(data.vendor).toEqual({ connect: { id: 42 } });
  });

  it("disconnects when null is given", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFkPatches({ vendorId: null }, data);
    expect(data.vendor).toEqual({ disconnect: true });
  });

  it("disconnects when empty-string is given", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFkPatches({ departmentId: "" }, data);
    expect(data.department).toEqual({ disconnect: true });
  });

  it("does NOT touch the field when key is absent (sparse patch contract)", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFkPatches({}, data);
    expect(data.vendor).toBeUndefined();
    expect(data.department).toBeUndefined();
  });

  it("connects every FK when all provided in one call", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFkPatches(
      {
        vendorId: 1,
        vendorStyleId: 2,
        departmentId: 3,
        categoryId: 4,
        typeId: 5,
        draftPoId: 6,
        stockLocationId: 7,
      },
      data,
    );
    expect(data.vendor).toEqual({ connect: { id: 1 } });
    expect(data.vendorStyle).toEqual({ connect: { id: 2 } });
    expect(data.department).toEqual({ connect: { id: 3 } });
    expect(data.category).toEqual({ connect: { id: 4 } });
    expect(data.type).toEqual({ connect: { id: 5 } });
    expect(data.draftPo).toEqual({ connect: { id: 6 } });
    expect(data.stockLocation).toEqual({ connect: { id: 7 } });
  });
});

describe("applyItemTextPatches", () => {
  it("trims required string fields when present", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ vendorName: "  X  ", partNumber: " P ", productName: " N " }, data);
    expect(data.vendorName).toBe("X");
    expect(data.partNumber).toBe("P");
    expect(data.productName).toBe("N");
  });

  it("ignores required string fields when value isn't a string (no clobber)", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ vendorName: 42 } as { vendorName: unknown }, data);
    expect(data.vendorName).toBeUndefined();
  });

  it("clears optional strings to null when empty / whitespace", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ description: "   ", barcode: "" }, data);
    expect(data.description).toBeNull();
    expect(data.barcode).toBeNull();
  });

  it("preserves non-empty optional strings", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ stockFamily: "WH Bevel Arm", notes: "needs new fabric" }, data);
    expect(data.stockFamily).toBe("WH Bevel Arm");
    expect(data.notes).toBe("needs new fabric");
  });

  it("does NOT touch absent keys", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({}, data);
    expect(data).toEqual({});
  });
});

describe("applyItemNumericPatches", () => {
  it("applies cost as Decimal when present", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemNumericPatches({ cost: 99.5 }, data);
    expect((data.cost as Prisma.Decimal).toString()).toBe("99.5");
  });

  it("throws on cost = '' (required field, can't clear via update)", () => {
    expect(() => applyItemNumericPatches({ cost: "" }, {})).toThrow(/cost is required/);
  });

  it("throws on cost = NaN-coerced value", () => {
    expect(() => applyItemNumericPatches({ retail: "abc" }, {})).toThrow(/retail must be/);
  });

  it("clears msrp to null when empty", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemNumericPatches({ msrp: "" }, data);
    expect(data.msrp).toBeNull();
  });

  it("clears dimensions to null when present-but-empty", () => {
    // productHeight: undefined IS in the body (the key exists), so it gets
    // cleared to null. Only an ABSENT key leaves the field untouched.
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemNumericPatches(
      { productWidth: null, productLength: "", productHeight: undefined },
      data,
    );
    expect(data.productWidth).toBeNull();
    expect(data.productLength).toBeNull();
    expect(data.productHeight).toBeNull();
  });

  it("leaves a dimension untouched when its key is genuinely absent", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemNumericPatches({ productWidth: 30 }, data);
    expect(data.productWidth).not.toBeUndefined();
    expect(data.productLength).toBeUndefined();
    expect(data.productHeight).toBeUndefined();
  });

  it("validates qty: throws on negative", () => {
    expect(() => applyItemNumericPatches({ qty: -1 }, {})).toThrow(/non-negative/);
  });

  it("validates qty: throws on float", () => {
    expect(() => applyItemNumericPatches({ qty: 1.5 }, {})).toThrow(/non-negative/);
  });

  it("accepts qty = 0 (legitimate value)", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemNumericPatches({ qty: 0 }, data);
    expect(data.qty).toBe(0);
  });

  it("does NOT touch cost when key absent", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemNumericPatches({}, data);
    expect(data.cost).toBeUndefined();
  });
});

describe("applyItemFlagPatches", () => {
  it("sets stockProgram to true", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFlagPatches({ stockProgram: true }, data);
    expect(data.stockProgram).toBe(true);
  });

  it("sets stockProgram to false on falsy non-bool", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFlagPatches({ stockProgram: 0 }, data);
    expect(data.stockProgram).toBe(false);
  });

  it("preserves configuration JSON", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFlagPatches({ configuration: { fabric: "Sky" } }, data);
    expect(data.configuration).toEqual({ fabric: "Sky" });
  });

  it("does NOT touch absent keys", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemFlagPatches({}, data);
    expect(data).toEqual({});
  });
});

describe("applyItemEnumPatches", () => {
  it("accepts valid status", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemEnumPatches({ status: "READY" }, data);
    expect(data.status).toBe("READY");
  });

  it("accepts every valid status value", () => {
    for (const s of VALID_ITEM_STATUSES) {
      const data: Prisma.BuyerDraftItemUpdateInput = {};
      applyItemEnumPatches({ status: s }, data);
      expect(data.status).toBe(s);
    }
  });

  it("throws on unknown status (no enum injection)", () => {
    expect(() => applyItemEnumPatches({ status: "WRONG" }, {})).toThrow(/Invalid status/);
  });

  it("throws on non-string status", () => {
    expect(() => applyItemEnumPatches({ status: 42 }, {})).toThrow(/Invalid status/);
  });

  it("accepts every valid source", () => {
    for (const s of VALID_SOURCES) {
      const data: Prisma.BuyerDraftItemUpdateInput = {};
      applyItemEnumPatches({ source: s }, data);
      expect(data.source).toBe(s);
    }
  });

  it("throws on unknown source", () => {
    expect(() => applyItemEnumPatches({ source: "WRONG" }, {})).toThrow(/Invalid source/);
  });

  it("does NOT touch absent keys", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemEnumPatches({}, data);
    expect(data).toEqual({});
  });
});

// ─── BuyerDraftItem buildItemUpdateData (aggregator) ──────────────────

describe("buildItemUpdateData", () => {
  it("stamps updatedBy on every patch", () => {
    expect(buildItemUpdateData({}, "alice").updatedBy).toBe("alice");
    expect(buildItemUpdateData({}, null).updatedBy).toBeNull();
  });

  it("aggregates FK + text + numeric + flag + enum patches in one call", () => {
    const data = buildItemUpdateData(
      {
        vendorId: 1,
        partNumber: "P-NEW",
        cost: 1500,
        stockProgram: true,
        status: "READY",
      },
      "alice",
    );
    expect(data.vendor).toEqual({ connect: { id: 1 } });
    expect(data.partNumber).toBe("P-NEW");
    expect((data.cost as Prisma.Decimal).toString()).toBe("1500");
    expect(data.stockProgram).toBe(true);
    expect(data.status).toBe("READY");
    expect(data.updatedBy).toBe("alice");
  });

  it("propagates throws from any underlying validator", () => {
    expect(() => buildItemUpdateData({ qty: -5 }, null)).toThrow(/non-negative/);
    expect(() => buildItemUpdateData({ status: "BOGUS" }, null)).toThrow(/Invalid status/);
    expect(() => buildItemUpdateData({ cost: "" }, null)).toThrow(/cost is required/);
  });

  it("returns essentially-empty data (just updatedBy) when body is empty", () => {
    const data = buildItemUpdateData({}, "alice");
    expect(Object.keys(data)).toEqual(["updatedBy"]);
  });
});

// ─── Slice 6.1 (2026-05-12) — fulfilledProductId / fulfilledAt ────────
//
// The barcode-lookup create body sets both fields so the catalog link is
// live the moment the draft lands. Both must be optional (other create
// paths don't set them); both must accept zero/null cleanly.

describe("buildItemCreateData — Slice 6.1 catalog link fields", () => {
  const minimal = {
    vendorName: "V",
    partNumber: "P1",
    productName: "Test",
    cost: 100,
    retail: 250,
  };

  it("persists fulfilledProductId + fulfilledAt when both are present", () => {
    const stamp = new Date("2026-05-12T15:00:00.000Z").toISOString();
    const data = buildItemCreateData(
      { ...minimal, fulfilledProductId: 1585, fulfilledAt: stamp },
      "alice",
    );
    expect(data.fulfilledProductId).toBe(1585);
    expect((data.fulfilledAt as Date).toISOString()).toBe(stamp);
  });

  it("accepts numeric-string fulfilledProductId (URL/form coercion shape)", () => {
    const data = buildItemCreateData(
      { ...minimal, fulfilledProductId: "1585", fulfilledAt: "2026-05-12T00:00:00.000Z" },
      null,
    );
    expect(data.fulfilledProductId).toBe(1585);
  });

  it("leaves both fields null when omitted (regular draft create)", () => {
    const data = buildItemCreateData(minimal, null);
    expect(data.fulfilledProductId).toBeNull();
    expect(data.fulfilledAt).toBeNull();
  });

  it("rejects garbage fulfilledAt to null (no crash) — link stays without timestamp is acceptable", () => {
    const data = buildItemCreateData(
      { ...minimal, fulfilledProductId: 1585, fulfilledAt: "not-a-date" },
      null,
    );
    expect(data.fulfilledProductId).toBe(1585);
    expect(data.fulfilledAt).toBeNull();
  });
});

// ─── Slice 4a: structured-field create + update ───────────────────────

describe("buildItemCreateData — structured configurator fields", () => {
  const minimal = {
    vendorName: "V",
    partNumber: "P1",
    productName: "Test",
    cost: 100,
    retail: 250,
  };

  it("captures grade / fabric / finish / cleaningCode / options when provided", () => {
    const data = buildItemCreateData(
      {
        ...minimal,
        grade: "13",
        fabric: "Stetson Chestnut",
        finish: "Mahogany",
        cleaningCode: "S",
        options: "Tufted Back, French Nailhead",
      },
      null,
    );
    expect(data.grade).toBe("13");
    expect(data.fabric).toBe("Stetson Chestnut");
    expect(data.finish).toBe("Mahogany");
    expect(data.cleaningCode).toBe("S");
    expect(data.options).toBe("Tufted Back, French Nailhead");
  });

  it("trims structured-field values", () => {
    const data = buildItemCreateData({ ...minimal, grade: "  13  ", fabric: "  Sky  " }, null);
    expect(data.grade).toBe("13");
    expect(data.fabric).toBe("Sky");
  });

  it("nulls structured fields when absent or empty", () => {
    const data = buildItemCreateData({ ...minimal, grade: "", finish: "  " }, null);
    expect(data.grade).toBeNull();
    expect(data.fabric).toBeNull();
    expect(data.finish).toBeNull();
    expect(data.cleaningCode).toBeNull();
    expect(data.options).toBeNull();
  });
});

describe("applyItemTextPatches — structured fields are sparse-patchable", () => {
  it("applies grade when present", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ grade: "13" }, data);
    expect(data.grade).toBe("13");
  });

  it("clears fabric to null when explicitly empty", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ fabric: "" }, data);
    expect(data.fabric).toBeNull();
  });

  it("does NOT touch absent structured-field keys (sparse contract)", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({}, data);
    expect(data.grade).toBeUndefined();
    expect(data.fabric).toBeUndefined();
    expect(data.finish).toBeUndefined();
    expect(data.cleaningCode).toBeUndefined();
    expect(data.options).toBeUndefined();
  });
});

// ─── Slice 4a: assembleDescription ────────────────────────────────────

describe("assembleDescription", () => {
  it("returns empty string when no fields are set", () => {
    expect(assembleDescription({})).toBe("");
  });

  it("emits Fabric / Grade / Finish / Cleaning Code / Options in order", () => {
    expect(
      assembleDescription({
        fabric: "Stetson Chestnut",
        grade: "13",
        finish: "Mahogany",
        cleaningCode: "S",
        options: "Tufted Back",
      }),
    ).toBe(
      "Fabric: Stetson Chestnut, Grade: 13, Finish: Mahogany, Cleaning Code: S, Options: Tufted Back",
    );
  });

  it("skips fields with empty / null / whitespace values", () => {
    expect(
      assembleDescription({
        fabric: "Sky",
        grade: "",
        finish: null,
        cleaningCode: "  ",
        options: "Welt",
      }),
    ).toBe("Fabric: Sky, Options: Welt");
  });

  it("includes Dimensions when at least one of W/L/H is present", () => {
    expect(
      assembleDescription({
        fabric: "Sky",
        productWidth: 30,
        productLength: 39.5,
        productHeight: 34,
      }),
    ).toBe("Fabric: Sky, Dimensions: 30W x 39.5D x 34H");
  });

  it("omits Dimensions when all dims are missing", () => {
    expect(
      assembleDescription({
        fabric: "Sky",
        productWidth: null,
        productLength: undefined,
        productHeight: "",
      }),
    ).toBe("Fabric: Sky");
  });

  it("includes a partial-dim Dimensions segment when only some are set", () => {
    expect(
      assembleDescription({
        productWidth: 30,
        productHeight: 34,
      }),
    ).toBe("Dimensions: 30W x 34H");
  });

  it("trims trailing zeros on dimensions (30.00 → '30', 39.5 stays)", () => {
    expect(
      assembleDescription({
        productWidth: 30.0,
        productLength: 39.5,
        productHeight: 33.25,
      }),
    ).toBe("Dimensions: 30W x 39.5D x 33.25H");
  });

  it("accepts string-encoded numbers for dims (Prisma Decimal serialization)", () => {
    expect(
      assembleDescription({
        productWidth: "30",
        productLength: "39.5",
      }),
    ).toBe("Dimensions: 30W x 39.5D");
  });

  it("ignores non-finite dimension values rather than crashing", () => {
    expect(
      assembleDescription({
        productWidth: "abc",
        productLength: 39.5,
      }),
    ).toBe("Dimensions: 39.5D");
  });

  it("UPHOLSTERY template emits header + ordered fields per buyer's 2026-05-09 spec", () => {
    expect(
      assembleDescription({
        itemType: "UPHOLSTERY",
        fabric: "Stetson Chestnut",
        grade: "13",
        finish: "Mahogany",
        cushions: "Mayfair",
        cleaningCode: "S",
        tossPillows: '(2) 22" knife edge in Calvin Sky',
        options: "Tufted Back",
        productWidth: 30,
        productLength: 39.5,
        productHeight: 34,
      }),
    ).toBe(
      "Fabric: Stetson Chestnut, Grade: 13, Finish: Mahogany, Cushions: Mayfair, Cleaning Code: S, Dimensions: 30W x 39.5D x 34H, " +
        'Toss Pillows: (2) 22" knife edge in Calvin Sky, Options: Tufted Back',
    );
  });

  it("UPHOLSTERY skips empty fields (no header emitted, per buyer 2026-05-09)", () => {
    expect(
      assembleDescription({
        itemType: "UPHOLSTERY",
        fabric: "Sky",
      }),
    ).toBe("Fabric: Sky");
  });

  it("CASE_GOODS template uses Wood Species + Hardware fields", () => {
    expect(
      assembleDescription({
        itemType: "CASE_GOODS",
        grade: "Walnut",
        finish: "Espresso",
        hardware: "Round knob",
        hardwareFinish: "Antique Brass",
        productWidth: 60,
        productLength: 18,
        productHeight: 32,
      }),
    ).toBe(
      "Wood Species: Walnut, Finish: Espresso, Hardware: Round knob, Hardware Finish: Antique Brass, " +
        "Dimensions: 60W x 18D x 32H",
    );
  });

  it("CASE_GOODS ignores upholstery-only fields", () => {
    // fabric / cushions / cleaningCode / tossPillows must NOT appear in case-goods output
    const out = assembleDescription({
      itemType: "CASE_GOODS",
      grade: "Walnut",
      // these should be silently ignored on the case-goods path
      fabric: "Sky",
      cushions: "Mayfair",
      cleaningCode: "S",
      tossPillows: "Two pillows",
    });
    expect(out).not.toContain("Fabric");
    expect(out).not.toContain("Cushions");
    expect(out).not.toContain("Cleaning Code");
    expect(out).not.toContain("Toss Pillows");
    expect(out).toBe("Wood Species: Walnut");
  });

  it("OTHER template (default) preserves the legacy comma-joined order", () => {
    // No itemType supplied → default behavior matches pre-template output
    expect(
      assembleDescription({
        fabric: "Stetson Chestnut",
        grade: "13",
        finish: "Mahogany",
        cleaningCode: "S",
        options: "Tufted Back",
        productWidth: 30,
        productLength: 39.5,
        productHeight: 34,
      }),
    ).toBe(
      "Fabric: Stetson Chestnut, Grade: 13, Finish: Mahogany, Cleaning Code: S, Options: Tufted Back, Dimensions: 30W x 39.5D x 34H",
    );
  });

  it("export-format produces multi-line UPHOLSTERY output for the POS", () => {
    expect(
      assembleDescriptionForExport({
        itemType: "UPHOLSTERY",
        fabric: "Stetson Chestnut",
        grade: "13",
        cushions: "Mayfair",
        cleaningCode: "S",
        productWidth: 30,
        productLength: 39.5,
        productHeight: 34,
      }),
    ).toBe(
      "Fabric: Stetson Chestnut\nGrade: 13\nCushions: Mayfair\nCleaning Code: S\nDimensions: 30W x 39.5D x 34H",
    );
  });

  it("matches the buyer's OTB-workbook convention exactly", () => {
    // From the actual OTB workbook (CR Laine sheet, row 2):
    // "Leather: Stetson Chestnut, Grade: 13, Cushion: Mayfair, Dimensions: 30W x 39.5D x 34H"
    // Our convention uses "Fabric:" rather than "Leather:" because the
    // wizard's vocabulary is unified (leather grades and fabric grades both
    // store in the `grade` column with the textual value). For the cushion
    // entry, the buyer uses the Options field.
    expect(
      assembleDescription({
        fabric: "Stetson Chestnut",
        grade: "13",
        options: "Cushion: Mayfair",
        productWidth: 30,
        productLength: 39.5,
        productHeight: 34,
      }),
    ).toBe(
      "Fabric: Stetson Chestnut, Grade: 13, Options: Cushion: Mayfair, Dimensions: 30W x 39.5D x 34H",
    );
  });
});

// ─── Slice 4a: assembleDescriptionForExport ───────────────────────────

describe("assembleDescriptionForExport", () => {
  it("joins with newlines instead of commas (the POS import expects multi-line)", () => {
    expect(
      assembleDescriptionForExport({
        fabric: "Stetson Chestnut",
        grade: "13",
        cleaningCode: "S",
      }),
    ).toBe("Fabric: Stetson Chestnut\nGrade: 13\nCleaning Code: S");
  });

  it("returns empty string when nothing is set", () => {
    expect(assembleDescriptionForExport({})).toBe("");
  });

  it("includes Dimensions on its own line", () => {
    expect(
      assembleDescriptionForExport({
        fabric: "Sky",
        productWidth: 30,
        productHeight: 34,
      }),
    ).toBe("Fabric: Sky\nDimensions: 30W x 34H");
  });

  it("contains the same segments as assembleDescription, just different separator", () => {
    const input = {
      fabric: "Stetson Chestnut",
      grade: "13",
      finish: "Mahogany",
      cleaningCode: "S",
      options: "Tufted Back",
      productWidth: 30,
      productLength: 39.5,
      productHeight: 34,
    };
    const csv = assembleDescription(input);
    const exp = assembleDescriptionForExport(input);
    expect(csv.split(", ").join("\n")).toBe(exp);
  });
});

// ─── Slice 4a: cleaning-code presets ──────────────────────────────────

describe("CLEANING_CODE_PRESETS", () => {
  it("contains the canonical industry codes", () => {
    const codes = CLEANING_CODE_PRESETS.map((p) => p.code);
    expect(codes).toContain("W");
    expect(codes).toContain("S");
    expect(codes).toContain("WS");
    expect(codes).toContain("X");
    expect(codes).toContain("DS");
  });

  it("each preset has a code and a human label", () => {
    for (const p of CLEANING_CODE_PRESETS) {
      expect(p.code).toMatch(/^[A-Z]{1,3}$/);
      expect(p.label).toContain(p.code);
      expect(p.label.length).toBeGreaterThan(p.code.length);
    }
  });

  it("label format is consistent: 'CODE — description'", () => {
    for (const p of CLEANING_CODE_PRESETS) {
      expect(p.label).toMatch(/^[A-Z]{1,3} — /);
    }
  });
});

// ─── Slice 4a: vignette + structured fields on create ─────────────────

describe("buildItemCreateData — vignette + extended structured fields", () => {
  const minimal = { vendorName: "V", partNumber: "P", productName: "T", cost: 1, retail: 1 };

  it("captures vignette when provided", () => {
    const data = buildItemCreateData({ ...minimal, vignette: "Vignette 3" }, null);
    expect(data.vignette).toBe("Vignette 3");
  });

  it("nulls vignette when absent", () => {
    const data = buildItemCreateData(minimal, null);
    expect(data.vignette).toBeNull();
  });

  it("trims vignette whitespace", () => {
    const data = buildItemCreateData({ ...minimal, vignette: "  Front Window  " }, null);
    expect(data.vignette).toBe("Front Window");
  });
});

describe("applyItemTextPatches — vignette is sparse-patchable", () => {
  it("applies vignette when present", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ vignette: "Living Room" }, data);
    expect(data.vignette).toBe("Living Room");
  });

  it("clears vignette to null on empty string", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({ vignette: "" }, data);
    expect(data.vignette).toBeNull();
  });

  it("does NOT touch vignette when key absent", () => {
    const data: Prisma.BuyerDraftItemUpdateInput = {};
    applyItemTextPatches({}, data);
    expect(data.vignette).toBeUndefined();
  });
});

// ─── BuyerDraftPurchaseOrder ──────────────────────────────────────────

describe("buildPoCreateData", () => {
  it("requires vendorName", () => {
    expect(() => buildPoCreateData({}, null)).toThrow(/vendorName is required/);
    expect(() => buildPoCreateData({ vendorName: "   " }, null)).toThrow(/vendorName is required/);
  });

  it("trims vendorName + accepts minimal body", () => {
    const data = buildPoCreateData({ vendorName: "  CR Laine  " }, "alice");
    expect(data.vendorName).toBe("CR Laine");
    expect(data.referenceNumber).toBeNull();
    expect(data.expectedShipMonth).toBeNull();
    expect(data.expectedDeliveryDate).toBeNull();
    expect(data.createdBy).toBe("alice");
  });

  it("captures all optional fields", () => {
    const data = buildPoCreateData(
      {
        vendorId: 1,
        vendorName: "V",
        referenceNumber: "PON12345",
        // Post-2026-05-13 DateTime promotion: input is YYYY-MM,
        // coerced to first-of-month UTC Date.
        expectedShipMonth: "2026-03",
        expectedDeliveryDate: "2026-03-15T00:00:00Z",
        storeLocationId: 42,
        notes: "Q1 stocking buy",
      },
      null,
    );
    expect(data.vendorId).toBe(1);
    expect(data.referenceNumber).toBe("PON12345");
    expect(data.expectedShipMonth).toBeInstanceOf(Date);
    expect((data.expectedShipMonth as Date).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(data.expectedDeliveryDate).toBeInstanceOf(Date);
    expect(data.storeLocationId).toBe(42);
    expect(data.notes).toBe("Q1 stocking buy");
  });

  it("coerces MM-YYYY expectedShipMonth to first-of-month UTC (iPad-Safari shape)", () => {
    const data = buildPoCreateData({ vendorName: "V", expectedShipMonth: "01-2026" }, null);
    expect(data.expectedShipMonth).toBeInstanceOf(Date);
    expect((data.expectedShipMonth as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("nulls expectedShipMonth when given legacy free-text like 'March'", () => {
    const data = buildPoCreateData({ vendorName: "V", expectedShipMonth: "March" }, null);
    expect(data.expectedShipMonth).toBeNull();
  });

  it("nulls expectedDeliveryDate when unparseable", () => {
    const data = buildPoCreateData({ vendorName: "V", expectedDeliveryDate: "not a date" }, null);
    expect(data.expectedDeliveryDate).toBeNull();
  });
});

describe("buildPoUpdateData", () => {
  it("stamps updatedBy + applies sparse patches", () => {
    const data = buildPoUpdateData({ referenceNumber: "PON-NEW" }, "bob");
    expect(data.referenceNumber).toBe("PON-NEW");
    expect(data.updatedBy).toBe("bob");
    expect(data.vendor).toBeUndefined();
  });

  it("clears referenceNumber to null on empty string", () => {
    const data = buildPoUpdateData({ referenceNumber: "" }, null);
    expect(data.referenceNumber).toBeNull();
  });

  it("disconnects vendor on null", () => {
    const data = buildPoUpdateData({ vendorId: null }, null);
    expect(data.vendor).toEqual({ disconnect: true });
  });

  it("connects vendor on integer", () => {
    const data = buildPoUpdateData({ vendorId: 7 }, null);
    expect(data.vendor).toEqual({ connect: { id: 7 } });
  });

  it("accepts every valid PO status", () => {
    for (const s of VALID_PO_STATUSES) {
      expect(buildPoUpdateData({ status: s }, null).status).toBe(s);
    }
  });

  it("throws on unknown status", () => {
    expect(() => buildPoUpdateData({ status: "WRONG" }, null)).toThrow(/Invalid status/);
  });

  it("trims vendorName when supplied", () => {
    const data = buildPoUpdateData({ vendorName: "  CRL  " }, null);
    expect(data.vendorName).toBe("CRL");
  });

  it("ignores vendorName when not a string", () => {
    const data = buildPoUpdateData({ vendorName: 42 } as { vendorName: unknown }, null);
    expect(data.vendorName).toBeUndefined();
  });
});

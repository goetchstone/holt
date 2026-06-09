// /app/__tests__/productPairingValidation.test.ts

import { validateProductPairingInput } from "@/lib/productPairingValidation";

describe("validateProductPairingInput", () => {
  const base = {
    name: "Bed -> Mattress",
    fromDepartmentId: 5,
    toDepartmentId: 9,
  };

  it("accepts the happy path with defaults", () => {
    const r = validateProductPairingInput(base);
    expect(r.ok).toBe(true);
    expect(r.data?.name).toBe("Bed -> Mattress");
    expect(r.data?.windowDays).toBe(60);
    expect(r.data?.isActive).toBe(true);
    expect(r.data?.sortOrder).toBe(0);
    expect(r.data?.description).toBeNull();
  });

  it("requires a non-empty name", () => {
    expect(validateProductPairingInput({ ...base, name: "" }).ok).toBe(false);
    expect(validateProductPairingInput({ ...base, name: "   " }).ok).toBe(false);
    expect(validateProductPairingInput({ ...base, name: undefined }).ok).toBe(false);
  });

  it("caps name at 120 chars", () => {
    const r = validateProductPairingInput({ ...base, name: "x".repeat(121) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("120");
  });

  it("requires positive integer department ids", () => {
    expect(validateProductPairingInput({ ...base, fromDepartmentId: 0 }).ok).toBe(false);
    expect(validateProductPairingInput({ ...base, fromDepartmentId: -1 }).ok).toBe(false);
    expect(validateProductPairingInput({ ...base, fromDepartmentId: "nope" }).ok).toBe(false);
    expect(validateProductPairingInput({ ...base, toDepartmentId: undefined }).ok).toBe(false);
  });

  it("rejects identical from/to (same dept, same cat)", () => {
    const r = validateProductPairingInput({
      ...base,
      fromDepartmentId: 5,
      toDepartmentId: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("same");
  });

  it("allows same dept when categories differ", () => {
    const r = validateProductPairingInput({
      ...base,
      fromDepartmentId: 5,
      fromCategoryId: 10,
      toDepartmentId: 5,
      toCategoryId: 11,
    });
    expect(r.ok).toBe(true);
  });

  it("defaults windowDays to 60 when omitted", () => {
    const r = validateProductPairingInput({ ...base, windowDays: undefined });
    expect(r.data?.windowDays).toBe(60);
  });

  it("bounds windowDays to 1..730", () => {
    expect(validateProductPairingInput({ ...base, windowDays: 0 }).ok).toBe(false);
    expect(validateProductPairingInput({ ...base, windowDays: 731 }).ok).toBe(false);
    expect(validateProductPairingInput({ ...base, windowDays: 1 }).ok).toBe(true);
    expect(validateProductPairingInput({ ...base, windowDays: 730 }).ok).toBe(true);
  });

  it("nullifies blank description and trims non-blank", () => {
    expect(validateProductPairingInput({ ...base, description: "" }).data?.description).toBeNull();
    expect(
      validateProductPairingInput({ ...base, description: "  some text  " }).data?.description,
    ).toBe("some text");
  });

  it("coerces string numeric ids from form inputs", () => {
    const r = validateProductPairingInput({
      ...base,
      fromDepartmentId: "5",
      toDepartmentId: "9",
      windowDays: "45",
      sortOrder: "10",
    });
    expect(r.ok).toBe(true);
    expect(r.data?.fromDepartmentId).toBe(5);
    expect(r.data?.windowDays).toBe(45);
    expect(r.data?.sortOrder).toBe(10);
  });
});

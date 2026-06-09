// /app/__tests__/excelUtils.test.ts

import { getCellValue } from "../src/lib/excelUtils";

describe("getCellValue", () => {
  const row = {
    Name: "Hartwell Sofa",
    Price: 1299.99,
    Description: "",
    Empty: null,
  };

  it("extracts value by exact key", () => {
    expect(getCellValue(row, "Name")).toBe("Hartwell Sofa");
  });

  it("converts numeric values to string", () => {
    expect(getCellValue(row, "Price")).toBe("1299.99");
  });

  it("returns empty string for empty value", () => {
    expect(getCellValue(row, "Description")).toBe("");
  });

  it("returns empty string for null value", () => {
    expect(getCellValue(row, "Empty")).toBe("");
  });

  it("returns empty string for missing key", () => {
    expect(getCellValue(row, "NonExistent")).toBe("");
  });

  it("tries multiple keys in order and returns first match", () => {
    expect(getCellValue(row, ["Missing", "Name"])).toBe("Hartwell Sofa");
  });

  it("returns empty string when no key matches", () => {
    expect(getCellValue(row, ["Missing1", "Missing2"])).toBe("");
  });

  it("skips empty values and finds next match", () => {
    expect(getCellValue(row, ["Description", "Name"])).toBe("Hartwell Sofa");
  });

  it("skips null values and finds next match", () => {
    expect(getCellValue(row, ["Empty", "Name"])).toBe("Hartwell Sofa");
  });
});

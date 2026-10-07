// /app/__tests__/wesleyHallParser.test.ts

import {
  parseWholesaleRows,
  parseFoundationsRows,
  parseFabricRows,
  detectColumns,
} from "../src/lib/pricing/wesleyHallParser";

// ─── detectColumns ──────────────────────────────────────────────────

describe("detectColumns", () => {
  it("maps standard Wesley Hall headers", () => {
    const headers = ["Style #", "Description", "Grade Riser", "14", "15", "16", "COM"];
    const { mapping, gradeColumns, unmapped } = detectColumns(headers);

    expect(mapping.styleNumber).toBe("Style #");
    expect(mapping.gradeRiser).toBe("Grade Riser");
    expect(gradeColumns).toContain("14");
    expect(gradeColumns).toContain("15");
    expect(gradeColumns).toContain("16");
    expect(gradeColumns).toContain("COM");
    expect(unmapped).toHaveLength(0);
  });

  it("maps alternative header names", () => {
    const headers = ["Style Number", "Desc", "Riser", "Width", "Depth"];
    const { mapping } = detectColumns(headers);

    expect(mapping.styleNumber).toBe("Style Number");
    expect(mapping.description).toBe("Desc");
    expect(mapping.gradeRiser).toBe("Riser");
    expect(mapping.overallWidth).toBe("Width");
    expect(mapping.overallDepth).toBe("Depth");
  });

  it("detects leather grade columns", () => {
    const headers = ["Style #", "C", "E", "F", "G", "COL"];
    const { gradeColumns } = detectColumns(headers);

    expect(gradeColumns).toContain("C");
    expect(gradeColumns).toContain("E");
    expect(gradeColumns).toContain("F");
    expect(gradeColumns).toContain("G");
    expect(gradeColumns).toContain("COL");
  });

  it("detects GRADE-prefixed columns", () => {
    const headers = ["Style #", "GRADE14", "GRADE15", "Grade 16"];
    const { gradeColumns } = detectColumns(headers);

    expect(gradeColumns).toContain("GRADE14");
    expect(gradeColumns).toContain("GRADE15");
    expect(gradeColumns).toContain("Grade 16");
  });

  it("identifies unmapped columns", () => {
    const headers = ["Style #", "14", "Some Random Column"];
    const { unmapped } = detectColumns(headers);

    expect(unmapped).toContain("Some Random Column");
  });

  it("handles empty headers", () => {
    const { mapping, gradeColumns, unmapped } = detectColumns([]);
    expect(Object.keys(mapping)).toHaveLength(0);
    expect(gradeColumns).toHaveLength(0);
    expect(unmapped).toHaveLength(0);
  });

  it("does case-insensitive matching", () => {
    const headers = ["style #", "description", "STANDARD SEAT"];
    const { mapping } = detectColumns(headers);

    expect(mapping.styleNumber).toBe("style #");
    expect(mapping.description).toBe("description");
    expect(mapping.standardSeat).toBe("STANDARD SEAT");
  });
});

// ─── parseWholesaleRows ─────────────────────────────────────────────

describe("parseWholesaleRows", () => {
  it("parses a minimal valid row with gradePrices object", () => {
    const rows = [
      {
        styleNumber: "1952",
        description: "Hartwell Sofa",
        styleName: "Hartwell",
        gradePrices: { "14": "1200", "15": "1300", "16": "1400" },
      },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].styleNumber).toBe("1952");
    expect(result.data[0].description).toBe("Hartwell Sofa");
    expect(result.data[0].gradePrices).toEqual([
      { grade: "14", cost: 1200 },
      { grade: "15", cost: 1300 },
      { grade: "16", cost: 1400 },
    ]);
    expect(result.summary.successCount).toBe(1);
    expect(result.summary.skippedCount).toBe(0);
  });

  it("parses CSV-style rows with grade columns directly on the row", () => {
    const rows = [
      {
        "Style #": "1952",
        Description: "Hartwell Sofa",
        "Style Name": "Hartwell",
        "Grade Riser": "25",
        "14": "$1,200",
        "15": "$1,300",
      },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].gradeRiser).toBe(25);
    expect(result.data[0].gradePrices).toHaveLength(2);
  });

  it("skips rows missing style number", () => {
    const rows = [
      {
        styleNumber: "",
        description: "Nameless",
        gradePrices: { "14": "1000" },
      },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.data).toHaveLength(0);
    expect(result.summary.skippedCount).toBe(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe("warning");
  });

  it("skips rows with no valid grade prices", () => {
    const rows = [
      {
        styleNumber: "1952",
        description: "Hartwell",
        gradePrices: { "14": "N/A", "15": "-" },
      },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.data).toHaveLength(0);
    expect(result.summary.skippedCount).toBe(1);
  });

  it("reports diagnostics for unparseable grade values", () => {
    const rows = [
      {
        styleNumber: "1952",
        description: "Hartwell",
        gradePrices: { "14": "1000", "15": "bad value" },
      },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.data).toHaveLength(1);
    const warnings = result.diagnostics.filter((d) => d.level === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain("Unparseable grade price");
  });

  it("parses option values correctly", () => {
    const rows = [
      {
        styleNumber: "1952",
        description: "Hartwell",
        styleName: "Hartwell",
        gradePrices: { "14": "1000" },
        decorativeFinish: "$75",
        springDownBdb: "Std",
        comfortDownBdb: "N/A",
      },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.data[0].decorativeFinishSurcharge).toBe(75);
    expect(result.data[0].decorativeFinishIsStandard).toBe(false);
    expect(result.data[0].springDownBdbSurcharge).toBe(0);
    expect(result.data[0].springDownBdbIsStandard).toBe(true);
    expect(result.data[0].comfortDownBdbSurcharge).toBeNull();
    expect(result.data[0].comfortDownBdbIsStandard).toBe(false);
  });

  it("parses dimension fields", () => {
    const rows = [
      {
        styleNumber: "1952",
        description: "Hartwell",
        gradePrices: { "14": "1000" },
        overallWidth: "86",
        overallDepth: "38",
        overallHeight: "36",
        seatHeight: "20",
        armHeight: "25",
        seatDepth: "22",
      },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.data[0].overallWidth).toBe(86);
    expect(result.data[0].overallDepth).toBe(38);
    expect(result.data[0].overallHeight).toBe(36);
    expect(result.data[0].seatHeight).toBe(20);
    expect(result.data[0].armHeight).toBe(25);
    expect(result.data[0].seatDepth).toBe(22);
  });

  it("counts summary statistics correctly", () => {
    const rows = [
      { styleNumber: "1001", description: "A", gradePrices: { "14": "1000" } },
      { styleNumber: "", description: "B", gradePrices: { "14": "1000" } },
      { styleNumber: "1003", description: "C", gradePrices: { "14": "1000" } },
    ];

    const result = parseWholesaleRows(rows);
    expect(result.summary.totalRowsProcessed).toBe(3);
    expect(result.summary.successCount).toBe(2);
    expect(result.summary.skippedCount).toBe(1);
  });

  it("handles empty input", () => {
    const result = parseWholesaleRows([]);
    expect(result.data).toHaveLength(0);
    expect(result.summary.totalRowsProcessed).toBe(0);
  });
});

// ─── parseFoundationsRows ───────────────────────────────────────────

describe("parseFoundationsRows", () => {
  it("parses a valid Foundations row", () => {
    const rows = [
      {
        "Style #": "F1952",
        Description: "Hartwell Sofa - Foundations",
        "Style Name": "Hartwell",
        "Foundations Cost": "$800",
        "Standard Seat": "Poly Dacron",
        "Standard Back": "Poly Fiber",
        "Spring-Down Seat": "$125",
        "CDC Seat/BDB Back": "Std",
        "Decorative Finish": "N/A",
      },
    ];

    const result = parseFoundationsRows(rows);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].styleNumber).toBe("F1952");
    expect(result.data[0].foundationsCost).toBe(800);
    expect(result.data[0].standardSeat).toBe("Poly Dacron");
    expect(result.data[0].springDownSeatSurcharge).toBe(125);
    expect(result.data[0].cdcSeatBdbBackSurcharge).toBe(0);
    expect(result.data[0].cdcSeatBdbBackIsStandard).toBe(true);
    expect(result.data[0].decorativeFinishSurcharge).toBeNull();
  });

  it("skips rows without style number", () => {
    const rows = [{ "Style #": "", "Foundations Cost": "500" }];
    const result = parseFoundationsRows(rows);
    expect(result.data).toHaveLength(0);
    expect(result.summary.skippedCount).toBe(1);
  });

  it("skips rows with invalid cost", () => {
    const rows = [{ "Style #": "F1952", "Foundations Cost": "N/A" }];
    const result = parseFoundationsRows(rows);
    expect(result.data).toHaveLength(0);
    expect(result.summary.skippedCount).toBe(1);
  });

  it("skips rows with zero cost", () => {
    const rows = [{ "Style #": "F1952", "Foundations Cost": "0" }];
    const result = parseFoundationsRows(rows);
    expect(result.data).toHaveLength(0);
  });
});

// ─── parseFabricRows ────────────────────────────────────────────────

describe("parseFabricRows", () => {
  it("parses fabric rows with standard column names", () => {
    const rows = [
      { "Fabric Pattern": "Amara", "Fabric Color": "Ivory", Grade: "14" },
      { "Fabric Pattern": "Amara", "Fabric Color": "Slate", Grade: "14" },
    ];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].fabricName).toBe("Amara");
    expect(result.data[0].colorName).toBe("Ivory");
    expect(result.data[0].grade).toBe("14");
  });

  it("deduplicates by fabricName + colorName", () => {
    const rows = [
      { "Fabric Pattern": "Amara", "Fabric Color": "Ivory", Grade: "14" },
      { "Fabric Pattern": "Amara", "Fabric Color": "Ivory", Grade: "14" },
    ];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(1);
    expect(result.summary.skippedCount).toBe(1);
  });

  it("deduplicates case-insensitively", () => {
    const rows = [
      { "Fabric Pattern": "AMARA", "Fabric Color": "ivory", Grade: "14" },
      { "Fabric Pattern": "amara", "Fabric Color": "IVORY", Grade: "14" },
    ];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(1);
  });

  it("skips inactive fabrics", () => {
    const rows = [
      { "Fabric Pattern": "Amara", "Fabric Color": "Ivory", Grade: "14", "Active/Inactive": "I" },
    ];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(0);
  });

  it("parses optional inventory fields", () => {
    const rows = [
      {
        "Fabric Pattern": "Amara",
        "Fabric Color": "Ivory",
        Grade: "14",
        "Swatch #": "AM-IVO",
        "Current Available": "350",
        "On Order": "100",
        "Expected Arrival Date": "04/01/2026",
      },
    ];

    const result = parseFabricRows(rows);
    expect(result.data[0].fabricCode).toBe("AM-IVO");
    expect(result.data[0].currentAvailable).toBe(350);
    expect(result.data[0].onOrder).toBe(100);
    expect(result.data[0].expectedArrival).toBe("04/01/2026");
  });

  it("errors when required columns are missing", () => {
    const rows = [{ SomeColumn: "value", AnotherColumn: "value" }];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(0);
    expect(result.diagnostics[0].level).toBe("error");
    expect(result.diagnostics[0].message).toContain("Required columns not found");
  });

  it("handles empty input", () => {
    const result = parseFabricRows([]);
    expect(result.data).toHaveLength(0);
    expect(result.summary.totalRowsProcessed).toBe(0);
  });

  it("skips rows with empty fabric name", () => {
    const rows = [{ "Fabric Pattern": "", "Fabric Color": "Ivory", Grade: "14" }];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(0);
  });

  it("skips rows with empty grade", () => {
    const rows = [{ "Fabric Pattern": "Amara", "Fabric Color": "Ivory", Grade: "" }];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(0);
  });

  it("uses alias columns for detection", () => {
    const rows = [{ Pattern: "Amara", Color: "Ivory", "Fabric Grade": "14" }];

    const result = parseFabricRows(rows);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].fabricName).toBe("Amara");
  });
});

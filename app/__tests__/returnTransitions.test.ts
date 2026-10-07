// /app/__tests__/returnTransitions.test.ts

import {
  isValidTransition,
  getValidTransitions,
  isTerminalState,
  suggestDisposition,
} from "@/lib/returnService";

describe("isValidTransition", () => {
  const validCases: [string, string][] = [
    ["INITIATED", "PICKUP_SCHEDULED"],
    ["INITIATED", "RECEIVED"],
    ["INITIATED", "CANCELLED"],
    ["PICKUP_SCHEDULED", "PICKUP_COMPLETED"],
    ["PICKUP_SCHEDULED", "CANCELLED"],
    ["PICKUP_COMPLETED", "RECEIVED"],
    ["PICKUP_COMPLETED", "CANCELLED"],
    ["RECEIVED", "INSPECTED"],
    ["RECEIVED", "CANCELLED"],
    ["INSPECTED", "RESTOCKED"],
    ["INSPECTED", "WRITTEN_OFF"],
    ["INSPECTED", "CLOSED"],
  ];

  test.each(validCases)("%s -> %s is valid", (from, to) => {
    expect(isValidTransition(from as any, to as any)).toBe(true);
  });

  const invalidCases: [string, string][] = [
    ["INITIATED", "INSPECTED"],
    ["INITIATED", "RESTOCKED"],
    ["RECEIVED", "PICKUP_SCHEDULED"],
    ["INSPECTED", "INITIATED"],
    ["RESTOCKED", "INSPECTED"],
    ["WRITTEN_OFF", "RESTOCKED"],
    ["CLOSED", "INITIATED"],
    ["CANCELLED", "INITIATED"],
    ["RESTOCKED", "CANCELLED"],
  ];

  test.each(invalidCases)("%s -> %s is invalid", (from, to) => {
    expect(isValidTransition(from as any, to as any)).toBe(false);
  });
});

describe("getValidTransitions", () => {
  it("returns correct transitions for INITIATED", () => {
    expect(getValidTransitions("INITIATED")).toEqual(["PICKUP_SCHEDULED", "RECEIVED", "CANCELLED"]);
  });

  it("returns correct transitions for PICKUP_SCHEDULED", () => {
    expect(getValidTransitions("PICKUP_SCHEDULED")).toEqual(["PICKUP_COMPLETED", "CANCELLED"]);
  });

  it("returns correct transitions for PICKUP_COMPLETED", () => {
    expect(getValidTransitions("PICKUP_COMPLETED")).toEqual(["RECEIVED", "CANCELLED"]);
  });

  it("returns correct transitions for RECEIVED", () => {
    expect(getValidTransitions("RECEIVED")).toEqual(["INSPECTED", "CANCELLED"]);
  });

  it("returns correct transitions for INSPECTED", () => {
    expect(getValidTransitions("INSPECTED")).toEqual(["RESTOCKED", "WRITTEN_OFF", "CLOSED"]);
  });

  it("returns empty array for terminal states", () => {
    expect(getValidTransitions("RESTOCKED")).toEqual([]);
    expect(getValidTransitions("WRITTEN_OFF")).toEqual([]);
    expect(getValidTransitions("CLOSED")).toEqual([]);
    expect(getValidTransitions("CANCELLED")).toEqual([]);
  });
});

describe("isTerminalState", () => {
  const terminalStates = ["RESTOCKED", "WRITTEN_OFF", "CLOSED", "CANCELLED"];

  test.each(terminalStates)("%s is terminal", (status) => {
    expect(isTerminalState(status as any)).toBe(true);
  });

  const nonTerminalStates = [
    "INITIATED",
    "PICKUP_SCHEDULED",
    "PICKUP_COMPLETED",
    "RECEIVED",
    "INSPECTED",
  ];

  test.each(nonTerminalStates)("%s is not terminal", (status) => {
    expect(isTerminalState(status as any)).toBe(false);
  });
});

describe("suggestDisposition", () => {
  it("suggests RESTOCKED for LIKE_NEW condition", () => {
    const result = suggestDisposition("LIKE_NEW");
    expect(result.action).toBe("RESTOCKED");
    expect(result.note).toBeTruthy();
  });

  it("suggests RESTOCKED for MINOR_DAMAGE condition", () => {
    const result = suggestDisposition("MINOR_DAMAGE");
    expect(result.action).toBe("RESTOCKED");
    expect(result.note).toContain("clearance");
  });

  it("suggests WRITTEN_OFF for MAJOR_DAMAGE condition", () => {
    const result = suggestDisposition("MAJOR_DAMAGE");
    expect(result.action).toBe("WRITTEN_OFF");
    expect(result.note).toContain("write-off");
  });

  it("suggests WRITTEN_OFF for UNSALVAGEABLE condition", () => {
    const result = suggestDisposition("UNSALVAGEABLE");
    expect(result.action).toBe("WRITTEN_OFF");
    expect(result.note).toContain("write off");
  });
});

// /app/__tests__/serviceDispatch.test.ts

import {
  isValidTransition,
  getValidTransitions,
  isTerminalState,
} from "@/lib/serviceDispatchService";

describe("isValidTransition", () => {
  const validCases: [string, string][] = [
    ["PENDING", "SCHEDULED"],
    ["PENDING", "CANCELLED"],
    ["SCHEDULED", "CONFIRMED"],
    ["SCHEDULED", "IN_PROGRESS"],
    ["SCHEDULED", "CANCELLED"],
    ["CONFIRMED", "IN_PROGRESS"],
    ["CONFIRMED", "CANCELLED"],
    ["IN_PROGRESS", "COMPLETED"],
    ["IN_PROGRESS", "CANCELLED"],
  ];

  test.each(validCases)("%s -> %s is valid", (from, to) => {
    expect(isValidTransition(from as any, to as any)).toBe(true);
  });

  const invalidCases: [string, string][] = [
    ["PENDING", "CONFIRMED"],
    ["PENDING", "IN_PROGRESS"],
    ["PENDING", "COMPLETED"],
    ["SCHEDULED", "PENDING"],
    ["SCHEDULED", "COMPLETED"],
    ["CONFIRMED", "PENDING"],
    ["CONFIRMED", "SCHEDULED"],
    ["CONFIRMED", "COMPLETED"],
    ["IN_PROGRESS", "PENDING"],
    ["IN_PROGRESS", "SCHEDULED"],
    ["IN_PROGRESS", "CONFIRMED"],
    ["COMPLETED", "PENDING"],
    ["COMPLETED", "CANCELLED"],
    ["COMPLETED", "IN_PROGRESS"],
    ["CANCELLED", "PENDING"],
    ["CANCELLED", "SCHEDULED"],
    ["CANCELLED", "IN_PROGRESS"],
  ];

  test.each(invalidCases)("%s -> %s is invalid", (from, to) => {
    expect(isValidTransition(from as any, to as any)).toBe(false);
  });

  it("returns false for unknown status", () => {
    expect(isValidTransition("BOGUS" as any, "PENDING" as any)).toBe(false);
  });
});

describe("getValidTransitions", () => {
  it("returns SCHEDULED and CANCELLED for PENDING", () => {
    expect(getValidTransitions("PENDING")).toEqual(["SCHEDULED", "CANCELLED"]);
  });

  it("returns CONFIRMED, IN_PROGRESS, CANCELLED for SCHEDULED", () => {
    expect(getValidTransitions("SCHEDULED")).toEqual(["CONFIRMED", "IN_PROGRESS", "CANCELLED"]);
  });

  it("returns IN_PROGRESS and CANCELLED for CONFIRMED", () => {
    expect(getValidTransitions("CONFIRMED")).toEqual(["IN_PROGRESS", "CANCELLED"]);
  });

  it("returns COMPLETED and CANCELLED for IN_PROGRESS", () => {
    expect(getValidTransitions("IN_PROGRESS")).toEqual(["COMPLETED", "CANCELLED"]);
  });

  it("returns empty array for terminal states", () => {
    expect(getValidTransitions("COMPLETED")).toEqual([]);
    expect(getValidTransitions("CANCELLED")).toEqual([]);
  });

  it("returns empty array for unknown status", () => {
    expect(getValidTransitions("BOGUS" as any)).toEqual([]);
  });
});

describe("isTerminalState", () => {
  const terminalStates = ["COMPLETED", "CANCELLED"];

  test.each(terminalStates)("%s is terminal", (status) => {
    expect(isTerminalState(status as any)).toBe(true);
  });

  const nonTerminalStates = ["PENDING", "SCHEDULED", "CONFIRMED", "IN_PROGRESS"];

  test.each(nonTerminalStates)("%s is not terminal", (status) => {
    expect(isTerminalState(status as any)).toBe(false);
  });
});

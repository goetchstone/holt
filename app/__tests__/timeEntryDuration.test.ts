// /app/__tests__/timeEntryDuration.test.ts

import { parseDurationToMinutes, formatMinutes } from "@/lib/timeEntries/duration";

describe("parseDurationToMinutes", () => {
  it("parses plain minutes", () => {
    expect(parseDurationToMinutes("90")).toBe(90);
    expect(parseDurationToMinutes("45m")).toBe(45);
  });

  it("parses hour shorthands", () => {
    expect(parseDurationToMinutes("2h")).toBe(120);
    expect(parseDurationToMinutes("1.5h")).toBe(90);
    expect(parseDurationToMinutes("1h30m")).toBe(90);
    expect(parseDurationToMinutes("1h 30m")).toBe(90);
  });

  it("parses h:mm clock form", () => {
    expect(parseDurationToMinutes("1:30")).toBe(90);
    expect(parseDurationToMinutes("0:45")).toBe(45);
  });

  it("rejects empty, junk, zero, and over-24h", () => {
    expect(() => parseDurationToMinutes("")).toThrow();
    expect(() => parseDurationToMinutes("soon")).toThrow("Enter time like");
    expect(() => parseDurationToMinutes("0")).toThrow("greater than zero");
    expect(() => parseDurationToMinutes("25h")).toThrow("24 hours");
  });
});

describe("formatMinutes", () => {
  it("renders minutes as h/m", () => {
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(0)).toBe("0m");
  });
});

// /app/__tests__/bookingScheduling.test.ts

import {
  DAY_OF_WEEK_LABELS,
  isValidHHMM,
  hhmmToMinutes,
  minutesToHHMM,
  slugify,
} from "@/lib/booking/scheduling";

describe("scheduling primitives", () => {
  it("labels all seven days starting Sunday", () => {
    expect(DAY_OF_WEEK_LABELS).toHaveLength(7);
    expect(DAY_OF_WEEK_LABELS[0]).toBe("Sunday");
    expect(DAY_OF_WEEK_LABELS[6]).toBe("Saturday");
  });

  it("validates HH:MM", () => {
    expect(isValidHHMM("09:00")).toBe(true);
    expect(isValidHHMM("23:59")).toBe(true);
    expect(isValidHHMM("9:00")).toBe(false);
    expect(isValidHHMM("24:00")).toBe(false);
    expect(isValidHHMM("12:60")).toBe(false);
  });

  it("converts between HH:MM and minutes", () => {
    expect(hhmmToMinutes("09:30")).toBe(570);
    expect(minutesToHHMM(570)).toBe("09:30");
    expect(minutesToHHMM(0)).toBe("00:00");
    expect(() => hhmmToMinutes("nope")).toThrow();
  });

  it("slugifies service names", () => {
    expect(slugify("Design Consultation")).toBe("design-consultation");
    expect(slugify("  A/B  Test! ")).toBe("a-b-test");
  });
});

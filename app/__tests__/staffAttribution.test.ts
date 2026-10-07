// /app/__tests__/staffAttribution.test.ts
//
// The classifier decides whether an unresolved salesperson name becomes an
// active staff record, an archived one, or nothing at all. Each outcome is
// wrong in a different, expensive way:
//
//   terminal treated as a person   -> an employee that never existed
//   person treated as a terminal   -> their sales erased from attribution
//   active person archived         -> hidden from pickers while still selling
//
// Cases mirror realistic shapes; names and counts are invented.

import {
  classifySalesperson,
  isTerminalName,
  staffRecordFor,
  DEPARTED_AFTER_DAYS,
} from "@/lib/staffAttribution";

const TODAY = new Date("2026-07-21T00:00:00Z");
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000);

describe("terminal logins are never people", () => {
  it("recognises POS station naming conventions", () => {
    for (const n of ["AARegister1", "AARegister4", "Bbregister2", "bbregister1", "CCRegister1"]) {
      expect(isTerminalName(n)).toBe(true);
    }
  });

  it("recognises bare system accounts", () => {
    for (const n of ["Admin", "admin", "Administrator", "System", "POS2"]) {
      expect(isTerminalName(n)).toBe(true);
    }
  });

  it("does not swallow people whose names merely contain a keyword", () => {
    // Erasing a real seller's attribution is the costlier mistake, so the
    // patterns anchor rather than match anywhere in the string.
    for (const n of ["Casey", "Robin", "Lena Goddard", "Owen Caldwell", "Theo Ashby"]) {
      expect(isTerminalName(n)).toBe(false);
    }
  });

  it("gives a terminal no staff record at all", () => {
    const c = classifySalesperson(
      { name: "AARegister1", orderCount: 5000, lastOrderDate: daysAgo(1) },
      TODAY,
    );
    expect(c.kind).toBe("terminal");
    expect(staffRecordFor(c)).toBeNull();
  });
});

describe("people are archived only once they have really gone", () => {
  it("archives someone long past the window", () => {
    // A departed seller's shape: hundreds of orders, last sale long ago.
    const c = classifySalesperson(
      { name: "Robin", orderCount: 900, lastOrderDate: daysAgo(245) },
      TODAY,
    );
    expect(c.kind).toBe("departed-person");
    expect(staffRecordFor(c)).toEqual({ role: "REGISTER", isDesigner: false, isActive: false });
  });

  it("keeps someone who sold last week active", () => {
    // Nora Barlow's shape: small volume, selling this month.
    const c = classifySalesperson(
      { name: "Nora Barlow", orderCount: 50, lastOrderDate: daysAgo(6) },
      TODAY,
    );
    expect(c.kind).toBe("active-person");
    expect(staffRecordFor(c)).toEqual({ role: "REGISTER", isDesigner: false, isActive: true });
  });

  it("does not archive at the boundary, only past it", () => {
    // A long furniture sales cycle must not read as departure.
    const at = classifySalesperson(
      { name: "Casey", orderCount: 300, lastOrderDate: daysAgo(DEPARTED_AFTER_DAYS) },
      TODAY,
    );
    expect(at.kind).toBe("active-person");
    const past = classifySalesperson(
      { name: "Casey", orderCount: 300, lastOrderDate: daysAgo(DEPARTED_AFTER_DAYS + 1) },
      TODAY,
    );
    expect(past.kind).toBe("departed-person");
  });
});

describe("new records never land in designer reporting", () => {
  it("marks every created person REGISTER and not a designer", () => {
    // These are Apparel and Home Shop sellers. They were missing precisely
    // because reporting was designer-only; adding them AS designers would put
    // them into commission reports they were never part of.
    for (const days of [10, 400]) {
      const c = classifySalesperson(
        { name: "Ivy Barrow", orderCount: 1, lastOrderDate: daysAgo(days) },
        TODAY,
      );
      const rec = staffRecordFor(c);
      expect(rec?.role).toBe("REGISTER");
      expect(rec?.isDesigner).toBe(false);
    }
  });
});

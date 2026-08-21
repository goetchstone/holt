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
// Cases are taken from the reference dataset's real shapes.

import {
  classifySalesperson,
  isTerminalName,
  staffRecordFor,
  DEPARTED_AFTER_DAYS,
} from "@/lib/staffAttribution";

const TODAY = new Date("2026-07-21T00:00:00Z");
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000);

describe("terminal logins are never people", () => {
  it("recognises the POS station conventions actually in the data", () => {
    for (const n of ["OSRegister1", "OSRegister4", "Chregister2", "chregister1", "GBRegister1"]) {
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
    for (const n of ["Sarah", "Allison", "Mary Goodwin", "Adam Calkins", "Reginald Adams"]) {
      expect(isTerminalName(n)).toBe(false);
    }
  });

  it("gives a terminal no staff record at all", () => {
    const c = classifySalesperson(
      { name: "OSRegister1", orderCount: 4304, lastOrderDate: daysAgo(1) },
      TODAY,
    );
    expect(c.kind).toBe("terminal");
    expect(staffRecordFor(c)).toBeNull();
  });
});

describe("people are archived only once they have really gone", () => {
  it("archives someone long past the window", () => {
    // Allison's shape: 904 orders, last sale well over a year ago.
    const c = classifySalesperson(
      { name: "Allison", orderCount: 904, lastOrderDate: daysAgo(245) },
      TODAY,
    );
    expect(c.kind).toBe("departed-person");
    expect(staffRecordFor(c)).toEqual({ role: "REGISTER", isDesigner: false, isActive: false });
  });

  it("keeps someone who sold last week active", () => {
    // Bridget Barnum's shape: small volume, selling this month.
    const c = classifySalesperson(
      { name: "Bridget Barnum", orderCount: 57, lastOrderDate: daysAgo(6) },
      TODAY,
    );
    expect(c.kind).toBe("active-person");
    expect(staffRecordFor(c)).toEqual({ role: "REGISTER", isDesigner: false, isActive: true });
  });

  it("does not archive at the boundary, only past it", () => {
    // A long furniture sales cycle must not read as departure.
    const at = classifySalesperson(
      { name: "Sarah", orderCount: 352, lastOrderDate: daysAgo(DEPARTED_AFTER_DAYS) },
      TODAY,
    );
    expect(at.kind).toBe("active-person");
    const past = classifySalesperson(
      { name: "Sarah", orderCount: 352, lastOrderDate: daysAgo(DEPARTED_AFTER_DAYS + 1) },
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
        { name: "Madison Baker", orderCount: 1, lastOrderDate: daysAgo(days) },
        TODAY,
      );
      const rec = staffRecordFor(c);
      expect(rec?.role).toBe("REGISTER");
      expect(rec?.isDesigner).toBe(false);
    }
  });
});

// /app/__tests__/commissionPeriodOverlap.test.ts
//
// Pure tests for `findOverlappingPayoutPeriods` — the guard that
// prevents an operator from generating a NEW pay period whose date
// range collides with an existing draft or locked one.

import {
  findOverlappingPayoutPeriods,
  describeOverlap,
  type PeriodLike,
} from "../src/lib/commissionPeriodOverlap";

function p(id: number, start: string, end: string, locked = false): PeriodLike {
  return {
    id,
    periodStart: new Date(start),
    periodEnd: new Date(end),
    lockedAt: locked ? new Date("2026-05-31T00:00:00Z") : null,
  };
}

describe("findOverlappingPayoutPeriods", () => {
  const candidateStart = new Date("2026-05-10T00:00:00Z");
  const candidateEnd = new Date("2026-05-25T00:00:00Z");

  it("returns [] when no existing payouts", () => {
    expect(findOverlappingPayoutPeriods(candidateStart, candidateEnd, [])).toEqual([]);
  });

  it("ignores an EXACT match (idempotent re-run is allowed)", () => {
    const existing = [p(1, "2026-05-10T00:00:00Z", "2026-05-25T00:00:00Z")];
    expect(findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing)).toEqual([]);
  });

  it("flags a partial overlap (left side)", () => {
    // existing 5/1-5/15, candidate 5/10-5/25 → overlap 5/10-5/15
    const existing = [p(1, "2026-05-01T00:00:00Z", "2026-05-15T00:00:00Z")];
    const conflicts = findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe(1);
  });

  it("flags a partial overlap (right side)", () => {
    // existing 5/20-5/31, candidate 5/10-5/25 → overlap 5/20-5/25
    const existing = [p(2, "2026-05-20T00:00:00Z", "2026-05-31T00:00:00Z")];
    const conflicts = findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe(2);
  });

  it("flags an existing range CONTAINED inside the candidate", () => {
    // existing 5/12-5/18, candidate 5/10-5/25
    const existing = [p(3, "2026-05-12T00:00:00Z", "2026-05-18T00:00:00Z")];
    const conflicts = findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe(3);
  });

  it("flags an existing range CONTAINING the candidate", () => {
    // existing 5/1-5/31, candidate 5/10-5/25
    const existing = [p(4, "2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z")];
    const conflicts = findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe(4);
  });

  it("does NOT flag a range that ends the day before the candidate starts (adjacent)", () => {
    // existing 5/1-5/9, candidate 5/10-5/25 → no overlap (5/9 < 5/10)
    const existing = [p(5, "2026-05-01T00:00:00Z", "2026-05-09T00:00:00Z")];
    expect(findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing)).toEqual([]);
  });

  it("flags a range that ends on the candidate's start day (boundary touch is overlap)", () => {
    // existing 5/1-5/10, candidate 5/10-5/25 → boundary day 5/10 is in BOTH
    const existing = [p(6, "2026-05-01T00:00:00Z", "2026-05-10T00:00:00Z")];
    const conflicts = findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe(6);
  });

  it("does NOT flag a range that starts the day after the candidate ends (adjacent)", () => {
    // existing 5/26-5/31, candidate 5/10-5/25 → no overlap (5/26 > 5/25)
    const existing = [p(7, "2026-05-26T00:00:00Z", "2026-05-31T00:00:00Z")];
    expect(findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing)).toEqual([]);
  });

  it("returns multiple overlapping rows sorted by periodStart ascending", () => {
    const existing = [
      p(10, "2026-05-20T00:00:00Z", "2026-05-31T00:00:00Z"),
      p(11, "2026-05-01T00:00:00Z", "2026-05-15T00:00:00Z"),
      p(12, "2026-05-12T00:00:00Z", "2026-05-14T00:00:00Z"),
    ];
    const conflicts = findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing);
    expect(conflicts.map((c) => c.id)).toEqual([11, 12, 10]);
  });

  it("flags both DRAFT and LOCKED rows (locked status doesn't matter for the check)", () => {
    const existing = [
      p(20, "2026-05-12T00:00:00Z", "2026-05-13T00:00:00Z", false), // draft
      p(21, "2026-05-20T00:00:00Z", "2026-05-22T00:00:00Z", true), // locked
    ];
    const conflicts = findOverlappingPayoutPeriods(candidateStart, candidateEnd, existing);
    expect(conflicts).toHaveLength(2);
  });

  it("returns [] when the candidate range is inverted (end before start)", () => {
    const existing = [p(30, "2026-05-12T00:00:00Z", "2026-05-13T00:00:00Z")];
    // candidateEnd < candidateStart — bad input from the caller; helper
    // refuses to flag anything (the caller would already reject the
    // range as invalid).
    expect(findOverlappingPayoutPeriods(candidateEnd, candidateStart, existing)).toEqual([]);
  });
});

describe("describeOverlap", () => {
  it("emits a human-readable summary with the locked badge", () => {
    const row: PeriodLike = {
      periodStart: new Date("2026-05-01T00:00:00Z"),
      periodEnd: new Date("2026-05-15T00:00:00Z"),
      lockedAt: new Date("2026-05-31T00:00:00Z"),
      staffMemberDisplayName: "Alice",
    };
    expect(describeOverlap(row)).toBe("2026-05-01 – 2026-05-15 Alice (LOCKED)");
  });

  it("emits the draft badge when no lock", () => {
    const row: PeriodLike = {
      periodStart: new Date("2026-05-16T00:00:00Z"),
      periodEnd: new Date("2026-05-31T00:00:00Z"),
      lockedAt: null,
    };
    expect(describeOverlap(row)).toBe("2026-05-16 – 2026-05-31 (draft)");
  });
});

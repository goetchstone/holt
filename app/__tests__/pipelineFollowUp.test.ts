// /app/__tests__/pipelineFollowUp.test.ts
//
// When a quote needs attention: a designer's next follow-up date wins over the
// 7-day clock, in both directions.

import {
  addDaysToCalendarDate,
  getFollowUpState,
  needsAttention,
  nextFollowUpAfterContact,
} from "@/lib/pipelineFollowUp";

const today = "2026-11-04";

describe("getFollowUpState", () => {
  it("runs the 7-day clock from last contact, with exactly 7 days still current", () => {
    const base = { nextFollowUpDate: null, lastContactDate: null, daysSinceCreated: 40, today };
    expect(getFollowUpState({ ...base, daysSinceContact: 7 })).toBe("current");
    expect(getFollowUpState({ ...base, daysSinceContact: 8 })).toBe("overdue");
  });

  it("falls back to the quote's age when nobody has made contact", () => {
    const base = { nextFollowUpDate: null, lastContactDate: null, daysSinceContact: null, today };
    expect(getFollowUpState({ ...base, daysSinceCreated: 7 })).toBe("current");
    expect(getFollowUpState({ ...base, daysSinceCreated: 8 })).toBe("overdue");
  });

  it("holds an old quote on plan until its future date", () => {
    expect(
      getFollowUpState({
        nextFollowUpDate: "2026-11-05",
        lastContactDate: "2026-08-06",
        daysSinceContact: 90,
        daysSinceCreated: 90,
        today,
      }),
    ).toBe("scheduled");
  });

  it("flags a recently contacted quote once its date arrives, today included", () => {
    const base = { lastContactDate: "2026-10-31", daysSinceContact: 4, daysSinceCreated: 4, today };
    expect(getFollowUpState({ ...base, nextFollowUpDate: today })).toBe("due");
    expect(getFollowUpState({ ...base, nextFollowUpDate: "2026-11-01" })).toBe("due");
  });

  it("clears a due date once someone reaches the client on or after it", () => {
    const base = { nextFollowUpDate: "2026-11-01", daysSinceCreated: 40, today };
    expect(getFollowUpState({ ...base, lastContactDate: "2026-11-03", daysSinceContact: 1 })).toBe(
      "current",
    );
    expect(getFollowUpState({ ...base, lastContactDate: "2026-11-01", daysSinceContact: 3 })).toBe(
      "current",
    );
  });

  it("goes back to the 7-day clock after that contact", () => {
    expect(
      getFollowUpState({
        nextFollowUpDate: "2026-10-01",
        lastContactDate: "2026-10-02",
        daysSinceContact: 33,
        daysSinceCreated: 40,
        today,
      }),
    ).toBe("overdue");
  });
});

describe("needsAttention", () => {
  it("covers overdue and due, not current or scheduled", () => {
    expect(needsAttention("overdue")).toBe(true);
    expect(needsAttention("due")).toBe(true);
    expect(needsAttention("current")).toBe(false);
    expect(needsAttention("scheduled")).toBe(false);
  });
});

describe("addDaysToCalendarDate", () => {
  it("crosses month and year ends", () => {
    expect(addDaysToCalendarDate("2026-11-28", 7)).toBe("2026-12-05");
    expect(addDaysToCalendarDate("2026-12-28", 14)).toBe("2027-01-11");
  });

  it("isn't thrown off by the daylight saving change", () => {
    expect(addDaysToCalendarDate("2026-10-31", 7)).toBe("2026-11-07");
  });
});

describe("nextFollowUpAfterContact", () => {
  it("keeps a plan still ahead and clears one the contact took care of", () => {
    expect(nextFollowUpAfterContact("2026-12-01", today)).toBe("2026-12-01");
    expect(nextFollowUpAfterContact(today, today)).toBeNull();
    expect(nextFollowUpAfterContact("2026-10-01", today)).toBeNull();
    expect(nextFollowUpAfterContact(null, today)).toBeNull();
  });
});

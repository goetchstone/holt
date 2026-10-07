// /app/__tests__/tillVariance.test.ts
//
// Pure classifier for Phase 0.6 till variance discipline
// (docs/domains/pos.md). Exhaustive boundary coverage: exactly-at-threshold
// stays in the LOWER tier ("strictly greater than"), one cent over crosses,
// and both overage (positive) and shortage (negative) variances of the
// same magnitude classify identically (CLAUDE.md rule: thresholds apply to
// the absolute value).

import {
  classifyTillVariance,
  hasVarianceNote,
  varianceNoteRequiredMessage,
  TILL_VARIANCE_NOTE_THRESHOLD,
  TILL_VARIANCE_MANAGER_THRESHOLD,
  TILL_VARIANCE_ESCALATION_THRESHOLD,
} from "@/lib/tillVariance";

describe("classifyTillVariance", () => {
  test("zero variance is NONE", () => {
    const c = classifyTillVariance(0);
    expect(c).toEqual({
      level: "NONE",
      requiresNote: false,
      requiresManager: false,
      blocksRegister: false,
    });
  });

  test("small variance well under $5 is NONE", () => {
    expect(classifyTillVariance(0.5).level).toBe("NONE");
    expect(classifyTillVariance(-0.5).level).toBe("NONE");
  });

  // ── $5 note boundary ──────────────────────────────────────────────────

  test("exactly $5.00 does NOT require a note (strictly greater than)", () => {
    const c = classifyTillVariance(5.0);
    expect(c.level).toBe("NONE");
    expect(c.requiresNote).toBe(false);
  });

  test("$5.01 crosses into NOTE", () => {
    const c = classifyTillVariance(5.01);
    expect(c).toEqual({
      level: "NOTE",
      requiresNote: true,
      requiresManager: false,
      blocksRegister: false,
    });
  });

  test("-$5.01 (shortage) classifies the same as +$5.01 (overage)", () => {
    expect(classifyTillVariance(-5.01)).toEqual(classifyTillVariance(5.01));
  });

  test("-$5.00 shortage does NOT require a note", () => {
    expect(classifyTillVariance(-5.0).requiresNote).toBe(false);
  });

  // ── $20 manager boundary ────────────────────────────────────────────────

  test("exactly $20.00 requires a note but NOT a manager", () => {
    const c = classifyTillVariance(20.0);
    expect(c.level).toBe("NOTE");
    expect(c.requiresNote).toBe(true);
    expect(c.requiresManager).toBe(false);
  });

  test("$20.01 crosses into MANAGER", () => {
    const c = classifyTillVariance(20.01);
    expect(c).toEqual({
      level: "MANAGER",
      requiresNote: true,
      requiresManager: true,
      blocksRegister: false,
    });
  });

  test("-$20.01 (shortage) also crosses into MANAGER", () => {
    const c = classifyTillVariance(-20.01);
    expect(c.level).toBe("MANAGER");
    expect(c.requiresManager).toBe(true);
    expect(c.blocksRegister).toBe(false);
  });

  // ── $100 escalation boundary ────────────────────────────────────────────

  test("exactly $100.00 requires a manager but does NOT escalate/block", () => {
    const c = classifyTillVariance(100.0);
    expect(c.level).toBe("MANAGER");
    expect(c.requiresManager).toBe(true);
    expect(c.blocksRegister).toBe(false);
  });

  test("$100.01 crosses into ESCALATION and blocks the register", () => {
    const c = classifyTillVariance(100.01);
    expect(c).toEqual({
      level: "ESCALATION",
      requiresNote: true,
      requiresManager: true,
      blocksRegister: true,
    });
  });

  test("-$100.01 (large shortage) also escalates and blocks", () => {
    const c = classifyTillVariance(-100.01);
    expect(c.level).toBe("ESCALATION");
    expect(c.blocksRegister).toBe(true);
  });

  test("large overage escalates exactly like a large shortage of the same magnitude", () => {
    expect(classifyTillVariance(500)).toEqual(classifyTillVariance(-500));
  });

  // ── constants sanity ─────────────────────────────────────────────────

  test("threshold constants match the documented Phase 0.6 values", () => {
    expect(TILL_VARIANCE_NOTE_THRESHOLD).toBe(5);
    expect(TILL_VARIANCE_MANAGER_THRESHOLD).toBe(20);
    expect(TILL_VARIANCE_ESCALATION_THRESHOLD).toBe(100);
  });
});

describe("hasVarianceNote", () => {
  test("false for undefined, null, empty, and whitespace-only", () => {
    expect(hasVarianceNote(undefined)).toBe(false);
    expect(hasVarianceNote(null)).toBe(false);
    expect(hasVarianceNote("")).toBe(false);
    expect(hasVarianceNote("   ")).toBe(false);
  });

  test("true for any non-blank string", () => {
    expect(hasVarianceNote("counted twice, confirmed short")).toBe(true);
    expect(hasVarianceNote("  ok  ")).toBe(true);
  });
});

describe("varianceNoteRequiredMessage", () => {
  test("reports the absolute variance regardless of sign", () => {
    expect(varianceNoteRequiredMessage(12.5)).toContain("$12.50");
    expect(varianceNoteRequiredMessage(-12.5)).toContain("$12.50");
    expect(varianceNoteRequiredMessage(-12.5)).not.toContain("-$12.50");
  });

  test("mentions the note threshold", () => {
    expect(varianceNoteRequiredMessage(12.5)).toContain("$5.00");
  });
});

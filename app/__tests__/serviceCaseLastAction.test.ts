// /app/__tests__/serviceCaseLastAction.test.ts
//
// Pure-helper tests for `computeLastActionAt`. The semantic invariant
// is: "Last Action" reflects when service activity (an opening or a
// note) last happened on the case — NOT when the row was last touched
// by an import. User-reported 2026-05-27.

import {
  computeLastActionAt,
  summarizeNoteText,
  buildLastActionTitle,
} from "../src/lib/serviceCaseLastAction";

describe("computeLastActionAt", () => {
  it("returns case.created when there are no notes", () => {
    const caseCreated = new Date("2025-10-03T12:00:00Z");
    expect(computeLastActionAt({ caseCreated }).getTime()).toBe(caseCreated.getTime());
  });

  it("returns the later of case.created vs latest note", () => {
    const caseCreated = new Date("2025-10-03T12:00:00Z");
    const latestNoteCreated = new Date("2025-12-15T10:30:00Z");
    expect(computeLastActionAt({ caseCreated, latestNoteCreated }).getTime()).toBe(
      latestNoteCreated.getTime(),
    );
  });

  it("returns case.created when it's later than the latest note", () => {
    // Defensive — shouldn't happen in real data (notes inherit from
    // case creation onward) but the helper must still be deterministic.
    const caseCreated = new Date("2025-12-20T12:00:00Z");
    const latestNoteCreated = new Date("2025-10-03T10:30:00Z");
    expect(computeLastActionAt({ caseCreated, latestNoteCreated }).getTime()).toBe(
      caseCreated.getTime(),
    );
  });

  it("treats latestNoteCreated=null the same as omitted", () => {
    const caseCreated = new Date("2025-10-03T12:00:00Z");
    expect(computeLastActionAt({ caseCreated, latestNoteCreated: null }).getTime()).toBe(
      caseCreated.getTime(),
    );
  });

  it("regression tripwire: does NOT consult `updated` — that's the whole point", () => {
    // The bug we fixed (user-reported 2026-05-27): including
    // case.updated made every re-imported row look like it had a
    // "last action" of today. The new shape doesn't accept `updated`
    // as input AT ALL — the type system guarantees the bug can't
    // sneak back via this helper. This test pins the signature.
    const caseCreated = new Date("2025-10-03T12:00:00Z");
    const latestNoteCreated = new Date("2025-10-04T12:00:00Z");
    // Deliberately constructing a today-stamp the OLD code would have
    // returned via case.updated. The helper IGNORES it (because there's
    // no field for it), returning the note date instead.
    const todayStamp = new Date();
    void todayStamp; // referenced for clarity; not passed to the helper

    const result = computeLastActionAt({ caseCreated, latestNoteCreated });
    expect(result.getTime()).toBe(latestNoteCreated.getTime());
    // Cross-check: definitely NOT today.
    expect(result.getTime()).toBeLessThan(new Date("2026-01-01T00:00:00Z").getTime());
  });
});

describe("summarizeNoteText", () => {
  it("returns null for null/undefined/empty/whitespace input", () => {
    expect(summarizeNoteText(null)).toBeNull();
    expect(summarizeNoteText(undefined)).toBeNull();
    expect(summarizeNoteText("")).toBeNull();
    expect(summarizeNoteText("   ")).toBeNull();
    expect(summarizeNoteText("\n\n   \t  ")).toBeNull();
  });

  it("returns the text unchanged when under the limit", () => {
    expect(summarizeNoteText("Short note")).toBe("Short note");
  });

  it("trims leading/trailing whitespace", () => {
    expect(summarizeNoteText("  trimmed  ")).toBe("trimmed");
  });

  it("collapses internal whitespace (newlines, tabs, multiple spaces)", () => {
    expect(summarizeNoteText("line one\n\nline two\t\twith   spaces")).toBe(
      "line one line two with spaces",
    );
  });

  it("truncates at maxChars + appends an ellipsis when over the limit", () => {
    const long = "a".repeat(120);
    const out = summarizeNoteText(long, 100);
    expect(out).toHaveLength(101); // 100 chars + "…" (single char)
    expect(out!.endsWith("…")).toBe(true);
  });

  it("breaks on the last word boundary inside the soft-floor (80% of maxChars)", () => {
    // 100 chars: "word " repeated 20 times = "word word ... word " — last
    // space before char 100 is at char 99 (the space before the 20th word
    // would be at char 95-ish). Should cut on space, not mid-word.
    const text = "word ".repeat(30); // 150 chars total
    const out = summarizeNoteText(text, 100);
    expect(out).not.toBeNull();
    // Cut should land on or after the 80-char soft-floor.
    const ellipsis = "…";
    const withoutEllipsis = out!.slice(0, -ellipsis.length);
    expect(withoutEllipsis.length).toBeGreaterThanOrEqual(80);
    expect(withoutEllipsis.length).toBeLessThanOrEqual(100);
    // No mid-word break: the trimmed prefix should end with a complete word.
    expect(withoutEllipsis.endsWith("word") || withoutEllipsis.endsWith(" ")).toBe(true);
  });

  it("hard-cuts at maxChars when there's no word boundary in the soft-floor (single long token)", () => {
    const text = "x".repeat(200); // one giant word, no spaces
    const out = summarizeNoteText(text, 100);
    // Hard cut at 100, then ellipsis.
    expect(out).toBe("x".repeat(100) + "…");
  });

  it("respects a custom maxChars argument", () => {
    expect(summarizeNoteText("hello world how are you", 5)).toBe("hello…");
  });
});

describe("buildLastActionTitle", () => {
  it("returns undefined when text is empty", () => {
    expect(buildLastActionTitle("Alex", "")).toBeUndefined();
    expect(buildLastActionTitle("Alex", null)).toBeUndefined();
    expect(buildLastActionTitle("Alex", undefined)).toBeUndefined();
  });

  it("returns text alone when author is missing", () => {
    expect(buildLastActionTitle(null, "left voicemail")).toBe("left voicemail");
    expect(buildLastActionTitle(undefined, "left voicemail")).toBe("left voicemail");
    expect(buildLastActionTitle("", "left voicemail")).toBe("left voicemail");
  });

  it("returns 'author: text' when both are present", () => {
    expect(buildLastActionTitle("Alex", "left voicemail")).toBe("Alex: left voicemail");
  });
});

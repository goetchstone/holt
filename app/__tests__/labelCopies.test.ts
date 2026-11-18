// Rule 14: the copies guard is pure. It is the one guard on every label print
// path (rule 42), so a bad value never reaches `zpl.repeat`.
import { MAX_TAG_COPIES, boundedTagCopies, tagCopiesProblem } from "@/lib/labels/tagCopies";

describe("tagCopiesProblem", () => {
  it("accepts 1 through the maximum", () => {
    expect(tagCopiesProblem(1)).toBeNull();
    expect(tagCopiesProblem(MAX_TAG_COPIES)).toBeNull();
  });

  it.each([
    ["non-integer", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["zero", 0],
    ["negative", -1],
    ["max + 1", MAX_TAG_COPIES + 1],
    ["huge", 1e9],
    ["numeric string", "2"],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s with a message that says what was wrong", (_n, value) => {
    expect(tagCopiesProblem(value)).toMatch(/whole number from 1 to 10/);
  });
});

describe("boundedTagCopies", () => {
  it("returns the value itself when it is in range", () => {
    expect(boundedTagCopies(1)).toBe(1);
    expect(boundedTagCopies(MAX_TAG_COPIES)).toBe(MAX_TAG_COPIES);
  });

  it.each([0, MAX_TAG_COPIES + 1, 1e9, 1.5, NaN, Infinity, "2", null])(
    "returns null for %p, never a clamped number",
    (value) => {
      expect(boundedTagCopies(value)).toBeNull();
    },
  );
});

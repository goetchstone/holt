// /app/__tests__/commentsContract.test.ts

import {
  COMMENT_STATUS_VALUES,
  COMMENT_MODERATION_VALUES,
  COMMENT_STATUS_LABELS,
  isPublicComment,
} from "@/lib/comments/contract";

describe("comment contract", () => {
  it("declares the status + moderation value sets", () => {
    expect(COMMENT_STATUS_VALUES).toEqual(["PENDING", "APPROVED", "REJECTED", "SPAM"]);
    expect(COMMENT_MODERATION_VALUES).toEqual(["APPROVED", "REJECTED", "SPAM"]);
    expect(COMMENT_MODERATION_VALUES).not.toContain("PENDING");
  });

  it("has a label for every status", () => {
    for (const s of COMMENT_STATUS_VALUES) expect(COMMENT_STATUS_LABELS[s]).toBeTruthy();
  });

  it("only renders APPROVED publicly", () => {
    expect(isPublicComment("APPROVED")).toBe(true);
    expect(isPublicComment("PENDING")).toBe(false);
    expect(isPublicComment("REJECTED")).toBe(false);
    expect(isPublicComment("SPAM")).toBe(false);
  });
});

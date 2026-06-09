// /app/__tests__/commentsRequestBody.test.ts

import { parseCommentCreateInput, parseCommentModerationInput } from "@/lib/comments/requestBody";

describe("parseCommentCreateInput", () => {
  it("accepts a valid comment and trims text", () => {
    const out = parseCommentCreateInput({
      postId: 7,
      authorName: "  Dana  ",
      authorEmail: "dana@example.com",
      content: "  Great post  ",
    });
    expect(out).toEqual({
      postId: 7,
      authorName: "Dana",
      authorEmail: "dana@example.com",
      content: "Great post",
    });
  });

  it("rejects a bad email, empty content, and a missing post id", () => {
    expect(() =>
      parseCommentCreateInput({ postId: 1, authorName: "A", authorEmail: "x", content: "y" }),
    ).toThrow("Enter a valid email");
    expect(() =>
      parseCommentCreateInput({
        postId: 1,
        authorName: "A",
        authorEmail: "a@b.com",
        content: "  ",
      }),
    ).toThrow("Write a comment");
    expect(() =>
      parseCommentCreateInput({ authorName: "A", authorEmail: "a@b.com", content: "y" }),
    ).toThrow();
  });
});

describe("parseCommentModerationInput", () => {
  it("accepts the three terminal statuses", () => {
    expect(parseCommentModerationInput({ status: "APPROVED" })).toEqual({ status: "APPROVED" });
    expect(parseCommentModerationInput({ status: "REJECTED" })).toEqual({ status: "REJECTED" });
    expect(parseCommentModerationInput({ status: "SPAM" })).toEqual({ status: "SPAM" });
  });

  it("rejects PENDING and unknown statuses", () => {
    expect(() => parseCommentModerationInput({ status: "PENDING" })).toThrow();
    expect(() => parseCommentModerationInput({ status: "NOPE" })).toThrow();
  });
});

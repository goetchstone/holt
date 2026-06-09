// /app/src/lib/comments/requestBody.ts
//
// Pure request-body validation for blog comments (CLAUDE.md rule 14). The public
// submit parser and the admin moderation parser each throw an Error with a
// user-facing message so the handler surfaces it via getErrorMessage.

import { z } from "zod";
import { COMMENT_MODERATION_VALUES } from "./contract";

function firstError(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

// Public submit (no auth).
export const commentCreateSchema = z.object({
  postId: z.number().int().positive(),
  authorName: z.string().trim().min(1, "Your name is required").max(120),
  authorEmail: z.email("Enter a valid email"),
  content: z.string().trim().min(1, "Write a comment").max(5000),
});
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;
export function parseCommentCreateInput(body: unknown): CommentCreateInput {
  const result = commentCreateSchema.safeParse(body);
  if (!result.success) throw new Error(firstError(result.error, "Invalid comment"));
  return result.data;
}

// Admin moderation -- move a comment to a terminal status.
export const commentModerationSchema = z.object({
  status: z.enum(COMMENT_MODERATION_VALUES),
});
export type CommentModerationInput = z.infer<typeof commentModerationSchema>;
export function parseCommentModerationInput(body: unknown): CommentModerationInput {
  const result = commentModerationSchema.safeParse(body);
  if (!result.success) throw new Error(firstError(result.error, "Invalid moderation"));
  return result.data;
}

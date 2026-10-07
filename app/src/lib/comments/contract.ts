// /app/src/lib/comments/contract.ts
//
// Shared client/server contract (CLAUDE.md rule 7) for blog comment moderation:
// the status values, labels, and the single predicate that decides what renders
// publicly. Imported by the moderation UI and the server. No I/O.

export const COMMENT_STATUS_VALUES = ["PENDING", "APPROVED", "REJECTED", "SPAM"] as const;
export type CommentStatusValue = (typeof COMMENT_STATUS_VALUES)[number];

// The states a moderator can move a comment INTO (PENDING is the initial state,
// not a moderation target).
export const COMMENT_MODERATION_VALUES = ["APPROVED", "REJECTED", "SPAM"] as const;
export type CommentModerationValue = (typeof COMMENT_MODERATION_VALUES)[number];

export const COMMENT_STATUS_LABELS: Record<CommentStatusValue, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SPAM: "Spam",
};

// Only APPROVED comments ever render on the public site.
export function isPublicComment(status: CommentStatusValue): boolean {
  return status === "APPROVED";
}

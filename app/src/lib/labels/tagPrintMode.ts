// /app/src/lib/labels/tagPrintMode.ts
//
// How someone prints tags while receiving (GAP-18), remembered per person
// (StaffMember.tagPrintMode). One at a time is the default, so each tag comes out
// as its piece is matched (owner, 2026-10-29). Pure: the screen and the server
// share it (rule 7).

export const TAG_PRINT_MODES = ["ONE_AT_A_TIME", "BATCH"] as const;
export type TagPrintMode = (typeof TAG_PRINT_MODES)[number];

/** What's stored, or the default for someone who hasn't chosen. */
export function readTagPrintMode(stored: string | null | undefined): TagPrintMode {
  return stored === "BATCH" ? "BATCH" : "ONE_AT_A_TIME";
}

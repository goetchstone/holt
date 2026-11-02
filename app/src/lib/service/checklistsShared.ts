// /app/src/lib/service/checklistsShared.ts
//
// GAP-11: service checklists. The limits and shapes the Settings screen, the
// case screen and the server (lib/service/checklists.ts) share. Client-safe: no
// Prisma here.

export const CHECKLIST_NAME_MAX = 80;
export const CHECKLIST_STEP_TITLE_MAX = 120;
export const CHECKLIST_STEP_NOTE_MAX = 500;
export const CHECKLIST_STEPS_MAX = 30;
/** A step is due at most a year after the checklist is applied (db-guards.sql). */
export const CHECKLIST_DUE_AFTER_DAYS_MAX = 365;

/** One step as the Settings screen sends it and reads it back. */
export interface ChecklistStepInput {
  title: string;
  description: string | null;
  /** Days after the checklist is applied that the task is due; null = no due date. */
  dueAfterDays: number | null;
}

/** A checklist as Settings > Service lists it: GET /api/service/checklists?all=1. */
export interface ChecklistRow {
  id: number;
  name: string;
  isActive: boolean;
  sortOrder: number;
  steps: ChecklistStepInput[];
}

/** A checklist a case can be given: GET /api/service/checklists. */
export interface ChecklistOption {
  id: number;
  name: string;
  stepCount: number;
}

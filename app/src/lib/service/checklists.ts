// /app/src/lib/service/checklists.ts
//
// GAP-11: service checklists (owner, 2026-11-01: task checklists). The store
// sets up the steps a kind of service job takes -- "order the part, book the
// tech, confirm with the customer" -- in Settings > Service; none ship. Staff
// apply one to a case, and each step becomes one of the case's tasks, due the
// step's number of days after today on the store's calendar.
//
// Applying COPIES the steps. A task is the case's own from then on: editing or
// deleting the checklist changes no case already given it. The task keeps the
// checklist's id only so the same checklist isn't applied to a case twice.

import type { Prisma, PrismaClient } from "@prisma/client";
import { addDays } from "@/lib/reports/businessDay";
import {
  CHECKLIST_DUE_AFTER_DAYS_MAX,
  CHECKLIST_NAME_MAX,
  CHECKLIST_STEPS_MAX,
  CHECKLIST_STEP_NOTE_MAX,
  CHECKLIST_STEP_TITLE_MAX,
  type ChecklistStepInput,
} from "@/lib/service/checklistsShared";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** A refusal the caller shows as it stands: 400, 404 or 409. */
export class ChecklistError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ChecklistError";
  }
}

/**
 * Advisory-lock space for applying a checklist to a case, so two clicks on Apply
 * can't both find the case without the checklist's tasks. Apart from the other
 * two-int spaces: 5_461_067 to 5_461_072 (stock, place setup, credit, refund,
 * return, truck).
 */
const CHECKLIST_APPLY_LOCK_SPACE = 5_461_073;

export interface ChecklistInput {
  name?: unknown;
  isActive?: unknown;
  sortOrder?: unknown;
  steps?: unknown;
}

const stepsInOrder = { orderBy: { position: "asc" as const } };

/** The store's checklists with their steps, in order; `activeOnly` for a case. */
export function listChecklists(db: Db, opts: { activeOnly?: boolean } = {}) {
  return db.serviceChecklist.findMany({
    where: opts.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { steps: stepsInOrder },
  });
}

function readName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new ChecklistError("Give the checklist a name.");
  if (name.length > CHECKLIST_NAME_MAX) {
    throw new ChecklistError(`Keep the name under ${CHECKLIST_NAME_MAX} characters.`);
  }
  return name;
}

function readOptionalFlags(input: ChecklistInput): { isActive?: boolean; sortOrder?: number } {
  const out: { isActive?: boolean; sortOrder?: number } = {};
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== "boolean") {
      throw new ChecklistError("isActive must be true or false.");
    }
    out.isActive = input.isActive;
  }
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || !Number.isInteger(input.sortOrder)) {
      throw new ChecklistError("sortOrder must be a whole number.");
    }
    out.sortOrder = input.sortOrder;
  }
  return out;
}

function readStep(raw: unknown, n: number): ChecklistStepInput {
  const step = (raw ?? {}) as Record<string, unknown>;
  const title = typeof step.title === "string" ? step.title.trim() : "";
  if (!title) throw new ChecklistError(`Step ${n} needs a title.`);
  if (title.length > CHECKLIST_STEP_TITLE_MAX) {
    throw new ChecklistError(
      `Keep step ${n}'s title under ${CHECKLIST_STEP_TITLE_MAX} characters.`,
    );
  }
  let description: string | null = null;
  if (step.description != null) {
    if (typeof step.description !== "string") {
      throw new ChecklistError(`Step ${n}'s note must be text.`);
    }
    description = step.description.trim() || null;
    if (description && description.length > CHECKLIST_STEP_NOTE_MAX) {
      throw new ChecklistError(
        `Keep step ${n}'s note under ${CHECKLIST_STEP_NOTE_MAX} characters.`,
      );
    }
  }
  let dueAfterDays: number | null = null;
  if (step.dueAfterDays != null) {
    const days = step.dueAfterDays;
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 0 ||
      days > CHECKLIST_DUE_AFTER_DAYS_MAX
    ) {
      throw new ChecklistError(
        `Step ${n} is due a whole number of days from 0 to ${CHECKLIST_DUE_AFTER_DAYS_MAX} after it's applied, or has no due date.`,
      );
    }
    dueAfterDays = days;
  }
  return { title, description, dueAfterDays };
}

/** The steps a checklist is saved with: at least one, at most CHECKLIST_STEPS_MAX. */
export function readSteps(raw: unknown): ChecklistStepInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ChecklistError("A checklist needs at least one step.");
  }
  if (raw.length > CHECKLIST_STEPS_MAX) {
    throw new ChecklistError(`A checklist can have at most ${CHECKLIST_STEPS_MAX} steps.`);
  }
  return raw.map((step, i) => readStep(step, i + 1));
}

async function assertNameFree(db: Db, name: string, exceptId?: number): Promise<void> {
  const clash = await db.serviceChecklist.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new ChecklistError(`There is already a checklist called "${name}".`, 409);
}

function stepRows(steps: ChecklistStepInput[]) {
  return steps.map((step, position) => ({ position, ...step }));
}

export async function createChecklist(db: Tx, input: ChecklistInput, by: string | null) {
  const name = readName(input.name);
  const steps = readSteps(input.steps);
  await assertNameFree(db, name);
  return db.serviceChecklist.create({
    data: {
      name,
      ...readOptionalFlags(input),
      createdBy: by,
      steps: { create: stepRows(steps) },
    },
    include: { steps: stepsInOrder },
  });
}

/**
 * Rename, reorder, switch off, or replace the steps. Steps sent are the whole
 * list: the saved ones are swapped for them, in the order sent.
 */
export async function updateChecklist(
  db: Tx,
  id: number,
  input: ChecklistInput,
  by: string | null,
) {
  const current = await db.serviceChecklist.findUnique({ where: { id }, select: { id: true } });
  if (!current) throw new ChecklistError("Checklist not found.", 404);
  const name = input.name === undefined ? undefined : readName(input.name);
  const steps = input.steps === undefined ? undefined : readSteps(input.steps);
  if (name !== undefined) await assertNameFree(db, name, id);
  if (steps) {
    await db.serviceChecklistStep.deleteMany({ where: { checklistId: id } });
    await db.serviceChecklistStep.createMany({
      data: stepRows(steps).map((row) => ({ ...row, checklistId: id })),
    });
  }
  return db.serviceChecklist.update({
    where: { id },
    data: { ...(name !== undefined ? { name } : {}), ...readOptionalFlags(input), updatedBy: by },
    include: { steps: stepsInOrder },
  });
}

/** Delete a checklist. Cases already given it keep their tasks. */
export async function deleteChecklist(db: Tx, id: number): Promise<void> {
  const current = await db.serviceChecklist.findUnique({ where: { id }, select: { id: true } });
  if (!current) throw new ChecklistError("Checklist not found.", 404);
  await db.serviceChecklist.delete({ where: { id } });
}

/** The DATE-like value a task's due date is stored as: midnight UTC of the day. */
function dueDateOf(today: string, dueAfterDays: number | null): Date | null {
  return dueAfterDays == null ? null : new Date(`${addDays(today, dueAfterDays)}T00:00:00.000Z`);
}

/**
 * Give a case a checklist's tasks: one per step, in step order, due the step's
 * days after `today` (the store's business day). Refused when the checklist is
 * switched off or empty, or the case already has its tasks.
 */
export async function applyChecklist(
  db: Tx,
  caseId: number,
  checklistId: number,
  ctx: { today: string; by: string | null },
): Promise<{ name: string; created: number }> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${CHECKLIST_APPLY_LOCK_SPACE}::int, ${caseId}::int)`;
  const serviceCase = await db.serviceCase.findUnique({
    where: { id: caseId },
    select: { id: true },
  });
  if (!serviceCase) throw new ChecklistError("Service case not found.", 404);
  const checklist = await db.serviceChecklist.findUnique({
    where: { id: checklistId },
    include: { steps: stepsInOrder },
  });
  if (!checklist) throw new ChecklistError("Checklist not found.", 404);
  if (!checklist.isActive) {
    throw new ChecklistError(`"${checklist.name}" is switched off.`, 409);
  }
  if (checklist.steps.length === 0) {
    throw new ChecklistError(`"${checklist.name}" has no steps.`, 409);
  }
  const earlier = await db.serviceTask.findFirst({
    where: { caseId, checklistId },
    select: { id: true },
  });
  if (earlier) {
    throw new ChecklistError(`This case already has the "${checklist.name}" tasks.`, 409);
  }
  await db.serviceTask.createMany({
    data: checklist.steps.map((step) => ({
      caseId,
      checklistId,
      title: step.title,
      description: step.description,
      dueDate: dueDateOf(ctx.today, step.dueAfterDays),
      createdBy: ctx.by,
    })),
  });
  return { name: checklist.name, created: checklist.steps.length };
}

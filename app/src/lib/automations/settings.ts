// /app/src/lib/automations/settings.ts
//
// GAP-37: each automation as the store set it up (Admin › Automations). One row per
// key in lib/automations/catalog.ts. A key with no row yet is written with what it
// starts as. Switching one on stamps activeSince, and it next runs at its next
// scheduled moment (lib/automations/schedule.ts). Same shape as lib/messages/settings.ts.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  AUTOMATION_CATALOG,
  AUTOMATION_KEYS,
  automationScheduleProblem,
  isAutomationKey,
  normalizeSchedule,
  type AutomationFrequency,
  type AutomationKey,
  type AutomationSchedule,
} from "./catalog";

type Db = Pick<Prisma.TransactionClient, "automationSetting">;

export class AutomationSettingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "AutomationSettingError";
  }
}

export type AutomationStatus = "RUNNING" | "OK" | "FAILED" | "SKIPPED";

export interface AutomationRow extends AutomationSchedule {
  key: AutomationKey;
  isActive: boolean;
  activeSince: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: AutomationStatus | null;
  lastSummary: string | null;
  updated: Date | null;
  updatedBy: string | null;
}

function toRow(key: AutomationKey, row: Prisma.AutomationSettingGetPayload<object>): AutomationRow {
  return {
    key,
    isActive: row.isActive,
    activeSince: row.activeSince,
    frequency: row.frequency as AutomationFrequency,
    everyMinutes: row.everyMinutes,
    hour: row.hour,
    weekday: row.weekday,
    lastStartedAt: row.lastStartedAt,
    lastFinishedAt: row.lastFinishedAt,
    lastStatus: row.lastStatus as AutomationStatus | null,
    lastSummary: row.lastSummary,
    updated: row.updated,
    updatedBy: row.updatedBy,
  };
}

/** Every automation's setting, in the catalog's order. */
export async function getAutomationSettings(db: Db = prisma): Promise<AutomationRow[]> {
  let rows = await db.automationSetting.findMany();
  const missing = AUTOMATION_KEYS.filter((key) => !rows.some((r) => r.key === key));
  if (missing.length > 0) {
    const now = new Date();
    await db.automationSetting.createMany({
      data: missing.map((key) => {
        const { startsOn, schedule } = AUTOMATION_CATALOG[key];
        return { key, isActive: startsOn, activeSince: startsOn ? now : null, ...schedule };
      }),
      skipDuplicates: true,
    });
    rows = await db.automationSetting.findMany();
  }
  return AUTOMATION_KEYS.flatMap((key) => {
    const row = rows.find((r) => r.key === key);
    return row ? [toRow(key, row)] : [];
  });
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Save whether it runs and when. Doesn't touch what it last did. */
export async function saveAutomationSetting(
  db: Db,
  keyInput: unknown,
  body: unknown,
  actor: string | null,
): Promise<AutomationRow> {
  if (!isAutomationKey(keyInput)) throw new AutomationSettingError("No such automation.", 404);
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.isActive !== "boolean") {
    throw new AutomationSettingError("On or off: isActive must be true or false.");
  }
  const schedule: AutomationSchedule = {
    frequency: input.frequency as AutomationFrequency,
    everyMinutes: nullableNumber(input.everyMinutes),
    hour: nullableNumber(input.hour),
    weekday: nullableNumber(input.weekday),
  };
  const problem = automationScheduleProblem(schedule, AUTOMATION_CATALOG[keyInput].frequencies);
  if (problem) throw new AutomationSettingError(problem);

  const existing = (await getAutomationSettings(db)).find((r) => r.key === keyInput);
  const switchedOn = input.isActive && !existing?.isActive;
  const saved = await db.automationSetting.update({
    where: { key: keyInput },
    data: {
      isActive: input.isActive,
      ...normalizeSchedule(schedule),
      ...(switchedOn ? { activeSince: new Date() } : {}),
      updatedBy: actor,
    },
  });
  return toRow(keyInput, saved);
}

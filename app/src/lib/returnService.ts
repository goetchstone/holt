// /app/src/lib/returnService.ts

import { prisma } from "@/lib/prisma";
import type { ReturnStatus, InspectionCondition } from "@prisma/client";

// Valid status transitions
const VALID_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  INITIATED: ["PICKUP_SCHEDULED", "RECEIVED", "CANCELLED"],
  PICKUP_SCHEDULED: ["PICKUP_COMPLETED", "CANCELLED"],
  PICKUP_COMPLETED: ["RECEIVED", "CANCELLED"],
  RECEIVED: ["INSPECTED", "CANCELLED"],
  INSPECTED: ["RESTOCKED", "WRITTEN_OFF", "CLOSED"],
  RESTOCKED: [],
  WRITTEN_OFF: [],
  CLOSED: [],
  CANCELLED: [],
};

export function isValidTransition(from: ReturnStatus, to: ReturnStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidTransitions(from: ReturnStatus): ReturnStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}

// Terminal states where no further transitions are possible
const TERMINAL_STATES: Set<ReturnStatus> = new Set([
  "RESTOCKED",
  "WRITTEN_OFF",
  "CLOSED",
  "CANCELLED",
]);

export function isTerminalState(status: ReturnStatus): boolean {
  return TERMINAL_STATES.has(status);
}

// Active states (not terminal)
const ACTIVE_STATES: ReturnStatus[] = [
  "INITIATED",
  "PICKUP_SCHEDULED",
  "PICKUP_COMPLETED",
  "RECEIVED",
  "INSPECTED",
];

export function getActiveStatuses(): ReturnStatus[] {
  return ACTIVE_STATES;
}

// Restock suggestion based on inspection condition
export function suggestDisposition(condition: InspectionCondition): {
  action: "RESTOCKED" | "WRITTEN_OFF";
  note: string;
} {
  switch (condition) {
    case "LIKE_NEW":
      return {
        action: "RESTOCKED",
        note: "Item in like-new condition, restock to original location",
      };
    case "MINOR_DAMAGE":
      return { action: "RESTOCKED", note: "Minor damage, consider clearance or as-is pricing" };
    case "MAJOR_DAMAGE":
      return { action: "WRITTEN_OFF", note: "Major damage, recommend write-off" };
    case "UNSALVAGEABLE":
      return { action: "WRITTEN_OFF", note: "Unsalvageable, write off" };
  }
}

// Generate return number: RET-YYMMDD-NNN
export async function generateReturnNumber(): Promise<string> {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const prefix = `RET-${yy}${mm}${dd}-`;

  const lastReturn = await prisma.return.findFirst({
    where: { returnNumber: { startsWith: prefix } },
    orderBy: { returnNumber: "desc" },
    select: { returnNumber: true },
  });

  let seq = 1;
  if (lastReturn) {
    const lastSeq = Number.parseInt(lastReturn.returnNumber.replace(prefix, ""), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${seq.toString().padStart(3, "0")}`;
}

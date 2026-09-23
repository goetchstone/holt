// /app/src/lib/tickets/numbering.ts
//
// Ticket-number generation in the house style PREFIX-YYMMDD-NNN (mirrors
// lib/returnService.ts generateReturnNumber). The pure parts -- the date prefix
// and the next-sequence formatting -- are split out so they unit-test without a
// DB; generateTicketNumber wires them to the latest row for the day.

import { getBusinessTimeZone } from "@/lib/appSettings";
import { prisma } from "@/lib/prisma";
import { businessDayStamp } from "@/lib/reports/businessDay";

/** `TKT-YYMMDD-` for the business day `date` falls on in `timeZone`. */
export function ticketNumberPrefix(date: Date, timeZone: string): string {
  return `TKT-${businessDayStamp(date, timeZone)}-`;
}

// Given the prefix and the most recent ticketNumber sharing it (or null when
// this is the first of the day), return the next number in sequence.
export function nextTicketNumber(prefix: string, lastNumber: string | null): string {
  let seq = 1;
  if (lastNumber) {
    const lastSeq = Number.parseInt(lastNumber.replace(prefix, ""), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `${prefix}${seq.toString().padStart(3, "0")}`;
}

export async function generateTicketNumber(now: Date = new Date()): Promise<string> {
  const prefix = ticketNumberPrefix(now, await getBusinessTimeZone());
  const last = await prisma.ticket.findFirst({
    where: { ticketNumber: { startsWith: prefix } },
    orderBy: { ticketNumber: "desc" },
    select: { ticketNumber: true },
  });
  return nextTicketNumber(prefix, last?.ticketNumber ?? null);
}

// /app/src/lib/tickets/numbering.ts
//
// Ticket-number generation in the house style PREFIX-YYMMDD-NNN (mirrors
// lib/returnService.ts generateReturnNumber). The pure parts -- the date prefix
// and the next-sequence formatting -- are split out so they unit-test without a
// DB; generateTicketNumber wires them to the latest row for the day.

import { prisma } from "@/lib/prisma";

export function ticketNumberPrefix(date: Date): string {
  const yy = date.getFullYear().toString().slice(-2);
  const mm = (date.getMonth() + 1).toString().padStart(2, "0");
  const dd = date.getDate().toString().padStart(2, "0");
  return `TKT-${yy}${mm}${dd}-`;
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
  const prefix = ticketNumberPrefix(now);
  const last = await prisma.ticket.findFirst({
    where: { ticketNumber: { startsWith: prefix } },
    orderBy: { ticketNumber: "desc" },
    select: { ticketNumber: true },
  });
  return nextTicketNumber(prefix, last?.ticketNumber ?? null);
}

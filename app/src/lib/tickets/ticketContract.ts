// /app/src/lib/tickets/ticketContract.ts
//
// Shared client/server contract (CLAUDE.md rule 7) for helpdesk tickets: the
// status + priority value lists, the allowed status-transition graph, human
// labels, and small pure predicates. Both the staff UI (dropdowns, badges) and
// the server (validation, status-change side effects) import from here so the
// two never drift. No I/O -- pure data + functions.

export const TICKET_STATUS_VALUES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_ON_CUSTOMER",
  "RESOLVED",
  "CLOSED",
] as const;
export type TicketStatusValue = (typeof TICKET_STATUS_VALUES)[number];

export const TICKET_PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type TicketPriorityValue = (typeof TICKET_PRIORITY_VALUES)[number];

// Human labels for the UI (DB enum values are SCREAMING_SNAKE).
export const TICKET_STATUS_LABELS: Record<TicketStatusValue, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  WAITING_ON_CUSTOMER: "Waiting on customer",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriorityValue, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

// Allowed status transitions. A ticket moves forward through the lifecycle,
// can bounce back to the customer, and can be reopened from a done state.
const VALID_TRANSITIONS: Record<TicketStatusValue, TicketStatusValue[]> = {
  OPEN: ["IN_PROGRESS", "WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED"],
  WAITING_ON_CUSTOMER: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: ["OPEN"],
};

export function isValidTicketTransition(from: TicketStatusValue, to: TicketStatusValue): boolean {
  if (from === to) return true; // a no-op status save is allowed
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidTicketTransitions(from: TicketStatusValue): TicketStatusValue[] {
  return VALID_TRANSITIONS[from] ?? [];
}

// "Open" = needs attention (counts toward the queue badge).
const OPEN_STATUSES = new Set<TicketStatusValue>(["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER"]);

export function isOpenTicketStatus(status: TicketStatusValue): boolean {
  return OPEN_STATUSES.has(status);
}

// RESOLVED + CLOSED are the "done" states -- entering either stamps resolvedAt.
export function isResolvedTicketStatus(status: TicketStatusValue): boolean {
  return status === "RESOLVED" || status === "CLOSED";
}

// Sort rank so URGENT floats to the top of the queue.
export const TICKET_PRIORITY_RANK: Record<TicketPriorityValue, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

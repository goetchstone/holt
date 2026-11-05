// /app/src/lib/clientOwnership.ts
//
// Who is working a quote. `salesPersonId` and `salesperson` say who the sale is credited
// to and feed commission, so handing off a client never changes them. A manager hands
// off a client by setting their primary designer: quotes credited to no active
// salesperson then show in that person's pipeline. Quotes under a register login, a name
// with no staff record, or someone who has left are otherwise in nobody's pipeline.
// Pure and unit-tested.

import { parseClientBookOptions, type ClientBookOptions } from "@/lib/clientBook";

export interface PipelineStaff {
  id: number;
  displayName: string;
  aliases: string[];
}

export interface OwnableQuote {
  salesPersonId: number | null;
  salesperson: string | null;
  customer?: { primaryDesignerId: number | null } | null;
}

/** Whether a quote's salesperson text is this person: their name or an alias, whole. Not
 *  containment, which makes "Ann" also "Anna Reyes" and lets one archive the other's
 *  quotes. A POS that writes names differently needs an alias on the staff record. */
function isNamed(salesperson: string | null, staff: PipelineStaff): boolean {
  const name = salesperson?.trim().toLowerCase();
  if (!name) return false;
  return [staff.displayName, ...staff.aliases].some(
    (candidate) => candidate.trim().toLowerCase() === name,
  );
}

export function nameMatchesActiveStaff(
  salesperson: string | null,
  activeStaff: readonly PipelineStaff[],
): boolean {
  return activeStaff.some((staff) => isNamed(salesperson, staff));
}

/** The linked id is the record of who a sale is credited to. The name only speaks for a
 *  quote with no id yet. */
function isAttributedTo(quote: OwnableQuote, staff: PipelineStaff): boolean {
  if (quote.salesPersonId !== null) return quote.salesPersonId === staff.id;
  return isNamed(quote.salesperson, staff);
}

/** The active salesperson whose pipeline this quote is in, or null if it's in nobody's.
 *  Whoever the sale is credited to comes first, then the client's assigned primary designer. */
export function findQuoteOwnerId(
  quote: OwnableQuote,
  activeStaff: readonly PipelineStaff[],
): number | null {
  const credited = activeStaff.find((staff) => isAttributedTo(quote, staff));
  if (credited) return credited.id;
  const assignedId = quote.customer?.primaryDesignerId;
  return activeStaff.some((staff) => staff.id === assignedId) ? (assignedId ?? null) : null;
}

export function isQuoteOwned(quote: OwnableQuote, activeStaff: readonly PipelineStaff[]): boolean {
  return findQuoteOwnerId(quote, activeStaff) !== null;
}

/** True when a salesperson should see this quote: it's credited to them, or they're the
 *  client's primary designer and it's credited to no one still working here. */
export function isQuoteInStaffPipeline(
  quote: OwnableQuote,
  staff: PipelineStaff,
  activeStaff: readonly PipelineStaff[],
): boolean {
  if (isAttributedTo(quote, staff)) return true;
  return (
    quote.customer?.primaryDesignerId === staff.id &&
    !activeStaff.some((other) => isAttributedTo(quote, other))
  );
}

export type ParsedAssignClients =
  | { ok: true; kind: "one"; customerId: number; toStaffId: number }
  | {
      ok: true;
      kind: "all-matching";
      options: ClientBookOptions;
      expectedCount: number;
      toStaffId: number;
    }
  | { ok: false; error: string };

function isPositiveId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** One client by id, or everyone matching the list on screen. A bulk assign must name who
 *  the clients worked with, so nobody assigns the whole list by accident. */
export function parseAssignClientsBody(body: unknown): ParsedAssignClients {
  const input = (body ?? {}) as Record<string, unknown>;
  const { toStaffId, customerId, expectedCount } = input;
  if (!isPositiveId(toStaffId)) return { ok: false, error: "toStaffId is required" };
  if (customerId !== undefined) {
    if (!isPositiveId(customerId)) return { ok: false, error: "customerId must be an id" };
    return { ok: true, kind: "one", customerId, toStaffId };
  }
  const options = parseClientBookOptions(input);
  if (!options.workedWith) {
    return { ok: false, error: "Choose who the clients worked with before assigning them all." };
  }
  if (!isPositiveId(expectedCount)) return { ok: false, error: "expectedCount is required" };
  return { ok: true, kind: "all-matching", options, expectedCount, toStaffId };
}

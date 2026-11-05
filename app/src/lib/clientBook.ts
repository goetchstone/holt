// /app/src/lib/clientBook.ts
//
// A salesperson's client book: everyone they have sold to or quoted, with the
// choices, filters and sort shared by the /sales/clients page and its API. A book can
// run to thousands of clients, so the server filters and pages them. Pure, so it is
// safe in client bundles.

import { getClientFollowUp } from "@/lib/pipelineFollowUp";
import { businessDayKey } from "@/lib/reports/businessDay";

export const CLIENT_BOOK_PAGE_SIZE = 50;

// Passed as the staff id to list the clients no one owns (managers only).
export const UNASSIGNED_STAFF_ID = "unassigned";

export const LAST_ORDER_FILTERS = [
  { value: "all", label: "Any last order" },
  { value: "within6m", label: "Last 6 months" },
  { value: "6to12m", label: "6 to 12 months ago" },
  { value: "1to2y", label: "1 to 2 years ago" },
  { value: "over2y", label: "Over 2 years ago" },
  { value: "never", label: "No orders yet" },
] as const;
export type LastOrderFilter = (typeof LAST_ORDER_FILTERS)[number]["value"];

export const CLIENT_NOTE_FILTERS = [
  { value: "all", label: "With or without notes" },
  { value: "withNotes", label: "With notes" },
  { value: "withoutNotes", label: "Without notes" },
] as const;
export type ClientNoteFilter = (typeof CLIENT_NOTE_FILTERS)[number]["value"];

export const CLIENT_BOOK_SORTS = [
  { value: "recent", label: "Most recent order" },
  { value: "spend", label: "Highest lifetime spend" },
  { value: "name", label: "Name" },
  { value: "lastContact", label: "Longest since contact" },
  { value: "nextFollowUp", label: "Next follow-up" },
] as const;
export type ClientBookSort = (typeof CLIENT_BOOK_SORTS)[number]["value"];

export const CLIENT_FOLLOW_UP_VIEWS = [
  { value: "all", label: "All clients" },
  { value: "suggested", label: "Suggested to reach out to" },
  { value: "due", label: "Follow-up due" },
  { value: "scheduled", label: "Follow-up scheduled" },
] as const;
export type ClientFollowUpView = (typeof CLIENT_FOLLOW_UP_VIEWS)[number]["value"];

// Who to suggest reaching out to. What counts as a big client depends on the store, so
// there are no suggestions until a store sets a lifetime spend (rule 63). The other two
// start from these and can be changed in Settings.
export const DEFAULT_OUTREACH_LAPSED_MONTHS = 12;
export const DEFAULT_OUTREACH_QUIET_DAYS = 90;

export interface OutreachRules {
  minLifetimeSpend: number;
  lapsedMonths: number;
  quietDays: number;
}

/** A store's rules, or null when it hasn't asked for suggestions. */
export function readOutreachRules(app: {
  outreachMinLifetimeSpend: number | null;
  outreachLapsedMonths: number | null;
  outreachQuietDays: number | null;
}): OutreachRules | null {
  if (app.outreachMinLifetimeSpend === null) return null;
  return {
    minLifetimeSpend: app.outreachMinLifetimeSpend,
    lapsedMonths: app.outreachLapsedMonths ?? DEFAULT_OUTREACH_LAPSED_MONTHS,
    quietDays: app.outreachQuietDays ?? DEFAULT_OUTREACH_QUIET_DAYS,
  };
}

export interface ClientBookOptions {
  search: string;
  lastOrder: LastOrderFilter;
  notes: ClientNoteFilter;
  followUp: ClientFollowUpView;
  sort: ClientBookSort;
  page: number;
  // The clients-with-no-owner list only: a former salesperson or register login.
  workedWith: string;
}

function readChoice<T extends string>(
  value: unknown,
  choices: readonly { value: T }[],
  fallback: T,
): T {
  return choices.find((choice) => choice.value === value)?.value ?? fallback;
}

/** Read the page's query string. An unknown value falls back to the default. */
export function parseClientBookOptions(query: Record<string, unknown>): ClientBookOptions {
  const page = Number.parseInt(String(query.page ?? ""), 10);
  return {
    search: typeof query.search === "string" ? query.search.trim() : "",
    workedWith: typeof query.workedWith === "string" ? query.workedWith.trim() : "",
    lastOrder: readChoice(query.lastOrder, LAST_ORDER_FILTERS, "all"),
    notes: readChoice(query.notes, CLIENT_NOTE_FILTERS, "all"),
    followUp: readChoice(query.followUp, CLIENT_FOLLOW_UP_VIEWS, "all"),
    sort: readChoice(query.sort, CLIENT_BOOK_SORTS, "recent"),
    page: Number.isNaN(page) || page < 1 ? 1 : page,
  };
}

export interface ClientBookEntry {
  customerId: number;
  firstName: string | null;
  lastName: string | null;
  lifetimeSpend: number;
  ordersWithStaff: number;
  lastOrderWithStaff: Date | null;
  openQuotes: number;
  hasNotes: boolean;
  lastContactAt: Date | null;
  nextFollowUpDate: string | null;
  // Set only when listing suggestions: this person's to work, and when the client last
  // bought from anyone. See markOutreachCandidates.
  isOutreachCandidate: boolean;
  lastOrderAnywhere: Date | null;
}

function monthsBefore(now: Date, months: number): Date {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

function matchesLastOrder(entry: ClientBookEntry, filter: LastOrderFilter, now: Date): boolean {
  if (filter === "all") return true;
  const lastOrder = entry.lastOrderWithStaff;
  if (filter === "never") return lastOrder === null;
  if (lastOrder === null) return false;

  const sixMonthsAgo = monthsBefore(now, 6);
  const oneYearAgo = monthsBefore(now, 12);
  const twoYearsAgo = monthsBefore(now, 24);
  if (filter === "within6m") return lastOrder >= sixMonthsAgo;
  if (filter === "6to12m") return lastOrder < sixMonthsAgo && lastOrder >= oneYearAgo;
  if (filter === "1to2y") return lastOrder < oneYearAgo && lastOrder >= twoYearsAgo;
  return lastOrder < twoYearsAgo;
}

function matchesNotes(entry: ClientBookEntry, filter: ClientNoteFilter): boolean {
  if (filter === "withNotes") return entry.hasNotes;
  if (filter === "withoutNotes") return !entry.hasNotes;
  return true;
}

/** The clock and rules a book is read by. */
export interface BookContext {
  now: Date;
  timeZone: string;
  rules: OutreachRules | null;
}

function clientFollowUp(entry: ClientBookEntry, context: BookContext) {
  const lastContact = entry.lastContactAt
    ? businessDayKey(entry.lastContactAt, context.timeZone)
    : null;
  return getClientFollowUp(
    entry.nextFollowUpDate,
    lastContact,
    businessDayKey(context.now, context.timeZone),
  );
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** A big client who has drifted: no open quote or follow-up, no order in a long while, and
 *  nobody has been in touch lately. Null rules means the store hasn't asked for these. */
export function isSuggestedOutreach(entry: ClientBookEntry, context: BookContext): boolean {
  const { rules, now } = context;
  if (!rules) return false;
  const lapsed =
    entry.lastOrderAnywhere !== null &&
    entry.lastOrderAnywhere < monthsBefore(now, rules.lapsedMonths);
  const quiet =
    entry.lastContactAt === null || entry.lastContactAt < daysBefore(now, rules.quietDays);
  return (
    entry.isOutreachCandidate &&
    entry.lifetimeSpend >= rules.minLifetimeSpend &&
    entry.openQuotes === 0 &&
    !clientFollowUp(entry, context) &&
    lapsed &&
    quiet
  );
}

function matchesFollowUpView(
  entry: ClientBookEntry,
  view: ClientFollowUpView,
  context: BookContext,
): boolean {
  if (view === "all") return true;
  if (view === "suggested") return isSuggestedOutreach(entry, context);
  return clientFollowUp(entry, context) === view;
}

export function filterClientBook(
  entries: ClientBookEntry[],
  options: Pick<ClientBookOptions, "lastOrder" | "notes" | "followUp">,
  context: BookContext,
): ClientBookEntry[] {
  return entries.filter(
    (entry) =>
      matchesLastOrder(entry, options.lastOrder, context.now) &&
      matchesNotes(entry, options.notes) &&
      matchesFollowUpView(entry, options.followUp, context),
  );
}

export interface WorkedWithOption {
  name: string;
  clientCount: number;
}

/** Who these clients have dealt with, most clients first. A selected name stays listed
 *  even with no clients left, so the dropdown never goes blank after a bulk assign. */
export function buildWorkedWithOptions(
  customerIds: number[],
  namesByCustomer: ReadonlyMap<number, ReadonlySet<string>>,
  selected: string,
): WorkedWithOption[] {
  const counts = new Map<string, number>();
  for (const customerId of customerIds) {
    for (const name of namesByCustomer.get(customerId) ?? []) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  if (selected && !counts.has(selected)) counts.set(selected, 0);
  return [...counts]
    .map(([name, clientCount]) => ({ name, clientCount }))
    .sort((a, b) => b.clientCount - a.clientCount || a.name.localeCompare(b.name));
}

function compareByName(a: ClientBookEntry, b: ClientBookEntry): number {
  const aName = `${a.lastName ?? ""} ${a.firstName ?? ""}`.trim();
  const bName = `${b.lastName ?? ""} ${b.firstName ?? ""}`.trim();
  return aName.localeCompare(bName);
}

/** Clients who never bought from this salesperson sort after everyone who has. */
function compareByRecentOrder(a: ClientBookEntry, b: ClientBookEntry): number {
  const aTime = a.lastOrderWithStaff?.getTime() ?? 0;
  const bTime = b.lastOrderWithStaff?.getTime() ?? 0;
  return bTime - aTime || compareByName(a, b);
}

function compareBySpend(a: ClientBookEntry, b: ClientBookEntry): number {
  return b.lifetimeSpend - a.lifetimeSpend || compareByName(a, b);
}

/** Never-contacted clients first, then whoever has waited longest. */
function compareByLastContact(a: ClientBookEntry, b: ClientBookEntry): number {
  const aTime = a.lastContactAt?.getTime() ?? 0;
  const bTime = b.lastContactAt?.getTime() ?? 0;
  return aTime - bTime || compareByName(a, b);
}

/** Soonest date first, clients with no date last. */
function compareByNextFollowUp(a: ClientBookEntry, b: ClientBookEntry): number {
  const aDate = a.nextFollowUpDate ?? "9999-12-31";
  const bDate = b.nextFollowUpDate ?? "9999-12-31";
  return aDate.localeCompare(bDate) || compareByName(a, b);
}

export function sortClientBook(
  entries: ClientBookEntry[],
  sort: ClientBookSort,
): ClientBookEntry[] {
  const compare = {
    recent: compareByRecentOrder,
    spend: compareBySpend,
    name: compareByName,
    lastContact: compareByLastContact,
    nextFollowUp: compareByNextFollowUp,
  }[sort];
  return [...entries].sort(compare);
}

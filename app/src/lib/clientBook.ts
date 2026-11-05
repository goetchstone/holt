// /app/src/lib/clientBook.ts
//
// A salesperson's client book: everyone they have sold to or quoted, with the
// choices, filters and sort shared by the /sales/clients page and its API. Books
// run up to about 2,400 clients (2026-10-30 backup), so the server filters and
// pages them. Pure, so it is safe in client bundles.

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
] as const;
export type ClientBookSort = (typeof CLIENT_BOOK_SORTS)[number]["value"];

export interface ClientBookOptions {
  search: string;
  lastOrder: LastOrderFilter;
  notes: ClientNoteFilter;
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

export function filterClientBook(
  entries: ClientBookEntry[],
  options: Pick<ClientBookOptions, "lastOrder" | "notes">,
  now: Date,
): ClientBookEntry[] {
  return entries.filter(
    (entry) =>
      matchesLastOrder(entry, options.lastOrder, now) && matchesNotes(entry, options.notes),
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

export function sortClientBook(
  entries: ClientBookEntry[],
  sort: ClientBookSort,
): ClientBookEntry[] {
  const compare = { recent: compareByRecentOrder, spend: compareBySpend, name: compareByName }[
    sort
  ];
  return [...entries].sort(compare);
}

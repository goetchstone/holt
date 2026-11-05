// /app/src/lib/followUpReport.ts
//
// Follow-ups across the whole team: the choices and rules shared by the manager report and
// the morning email (GAP-36). Each follow-up belongs to one person, so one person gets the
// reminder. Pure, so it is safe in client bundles.

export const FOLLOW_UP_REPORT_STATUSES = [
  { value: "open", label: "Due and scheduled" },
  { value: "due", label: "Due" },
  { value: "scheduled", label: "Scheduled" },
  { value: "done", label: "Done (contacted since)" },
  { value: "all", label: "All" },
] as const;
export type FollowUpReportStatus = (typeof FOLLOW_UP_REPORT_STATUSES)[number]["value"];

/** How far back the report counts contacts logged per salesperson. */
export const CONTACT_WINDOW_DAYS = 30;

export interface FollowUpReportFilters {
  status: FollowUpReportStatus;
  owner: string;
  store: string;
  from: string;
  to: string;
}

export const DEFAULT_FOLLOW_UP_FILTERS: FollowUpReportFilters = {
  status: "open",
  owner: "",
  store: "",
  from: "",
  to: "",
};

export interface FollowUpRow {
  customerId: number;
  clientName: string;
  ownerId: number | null;
  owner: string;
  store: string;
  nextFollowUpDate: string;
  status: "due" | "scheduled" | "done";
  lastContact: string | null;
  lastNote: string | null;
  phone: string | null;
  email: string | null;
  openQuotes: number;
  openQuoteValue: number;
  lifetimeSpend: number;
  closeLikelihood: number | null;
  projectTimeline: string | null;
  budgetRange: string | null;
}

export function filterFollowUpRows(
  rows: readonly FollowUpRow[],
  filters: FollowUpReportFilters,
): FollowUpRow[] {
  return rows.filter((row) => {
    const matchesStatus =
      filters.status === "all" ||
      row.status === filters.status ||
      (filters.status === "open" && row.status !== "done");
    return (
      matchesStatus &&
      (!filters.owner || row.owner === filters.owner) &&
      (!filters.store || row.store === filters.store) &&
      (!filters.from || row.nextFollowUpDate >= filters.from) &&
      (!filters.to || row.nextFollowUpDate <= filters.to)
    );
  });
}

export interface RecentContacts {
  owner: string;
  contactsLogged: number;
  aboutClientNotQuote: number;
}

export interface FollowUpOwnerSummary extends RecentContacts {
  due: number;
  scheduled: number;
  openQuoteValue: number;
}

/** One row per salesperson. Anyone with logged contacts shows up, even with no dates set,
 *  so a manager can see outreach happening as well as what's outstanding. What's done
 *  doesn't count toward what's outstanding. */
export function summarizeFollowUps(
  rows: readonly FollowUpRow[],
  contacts: readonly RecentContacts[],
): FollowUpOwnerSummary[] {
  const byOwner = new Map<string, FollowUpOwnerSummary>();
  const summaryFor = (owner: string) => {
    const known = byOwner.get(owner);
    if (known) return known;
    const created: FollowUpOwnerSummary = {
      owner,
      due: 0,
      scheduled: 0,
      openQuoteValue: 0,
      contactsLogged: 0,
      aboutClientNotQuote: 0,
    };
    byOwner.set(owner, created);
    return created;
  };

  for (const row of rows) {
    if (row.status === "done") continue;
    const summary = summaryFor(row.owner);
    if (row.status === "due") summary.due++;
    if (row.status === "scheduled") summary.scheduled++;
    summary.openQuoteValue += row.openQuoteValue;
  }
  for (const contact of contacts) {
    const summary = summaryFor(contact.owner);
    summary.contactsLogged = contact.contactsLogged;
    summary.aboutClientNotQuote = contact.aboutClientNotQuote;
  }
  return [...byOwner.values()].sort(
    (a, b) => b.due - a.due || b.scheduled - a.scheduled || a.owner.localeCompare(b.owner),
  );
}

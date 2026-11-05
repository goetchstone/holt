// /app/src/lib/clientBookQuery.ts
//
// Server-only read behind the client book. A client belongs to a salesperson's
// book when a manager assigned them, or when an order or quote is attributed to them:
// by id, by split credit, or by name or alias (about a quarter of sold orders only
// carry the name). Returns are left out, since the sale they reverse already puts the
// client in the book.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import {
  CLIENT_BOOK_PAGE_SIZE,
  buildWorkedWithOptions,
  filterClientBook,
  sortClientBook,
  type WorkedWithOption,
  type ClientBookEntry,
  type ClientBookOptions,
} from "@/lib/clientBook";
import { isQuoteOwned, nameMatchesActiveStaff } from "@/lib/clientOwnership";
import { toClientProfileView, type ClientProfileView } from "@/lib/clientProfile";
import { calculateLeadScore, leadScoreInputFromCustomer, type LeadTier } from "@/lib/leadScore";
import {
  callablePhone,
  isCashSaleCustomer,
  mailableEmail,
  type PipelineClientHistory,
} from "@/lib/pipelineClient";
import { fetchClientBackground } from "@/lib/pipelineClientQuery";

const MAX_NOTES_PER_CLIENT = 25;
const BOOK_STATUSES = ["QUOTE", "ORDER", "FULFILLED"] as const;

export interface ClientBookNote {
  id: number;
  source: string;
  notes: string;
  startedAt: string;
  staffName: string;
  orderno: string | null;
}

export interface ClientBookRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  leadTier: LeadTier;
  history: PipelineClientHistory;
  ordersWithStaff: number;
  lastOrderWithStaff: string | null;
  openQuotes: number;
  profile: ClientProfileView | null;
  notes: ClientBookNote[];
  isAssigned: boolean; // a manager assigned this client to the salesperson
  lastSalesperson: string | null; // set only when listing clients no one owns
}

export interface ClientBookPage {
  rows: ClientBookRow[];
  total: number;
  // The clients-with-no-owner list only.
  workedWithOptions: WorkedWithOption[];
  ownerlessQuoteCount: number;
}

export interface ClientBookStaff {
  id: number;
  displayName: string;
  aliases: string[];
}

function attributedTo(staff: ClientBookStaff): Prisma.SalesOrderWhereInput {
  const names = [staff.displayName, ...staff.aliases];
  return {
    OR: [
      { salesPersonId: staff.id },
      { splitWithId: staff.id },
      ...names.map((name) => ({
        salesPersonId: null,
        salesperson: { equals: name, mode: "insensitive" as const },
      })),
    ],
  };
}

/** Which clients a page lists, and which of their orders it counts. */
interface BookScope {
  orders: Prisma.SalesOrderWhereInput;
  assignedIds: Set<number>;
  openQuotes: Map<number, number>;
  // Former salespeople and register logins each client dealt with (no-owner list only).
  workedWith: Map<number, Set<string>>;
}

async function staffBookScope(staff: ClientBookStaff): Promise<BookScope> {
  const orders = attributedTo(staff);
  const [assigned, credited, assignedQuotes, activeStaff] = await Promise.all([
    prisma.customer.findMany({ where: { primaryDesignerId: staff.id }, select: { id: true } }),
    prisma.salesOrder.groupBy({
      by: ["customerId"],
      where: { ...orders, customerId: { not: null }, status: "QUOTE", pipelineArchivedAt: null },
      _count: { _all: true },
    }),
    prisma.salesOrder.findMany({
      where: {
        customer: { primaryDesignerId: staff.id },
        status: "QUOTE",
        pipelineArchivedAt: null,
      },
      select: { customerId: true, salesPersonId: true, salesperson: true },
    }),
    prisma.staffMember.findMany({
      where: { isActive: true },
      select: { id: true, displayName: true, aliases: true },
    }),
  ]);

  const openQuotes = new Map<number, number>();
  for (const row of credited) {
    if (row.customerId !== null) openQuotes.set(row.customerId, row._count._all);
  }
  // Quotes with no active salesperson are this person's because the client is assigned.
  // An active salesperson's quote, this person's included, is already counted or not theirs.
  for (const quote of assignedQuotes) {
    if (quote.customerId === null || isQuoteOwned(quote, activeStaff)) continue;
    openQuotes.set(quote.customerId, (openQuotes.get(quote.customerId) ?? 0) + 1);
  }
  return {
    orders,
    assignedIds: new Set(assigned.map((customer) => customer.id)),
    openQuotes,
    workedWith: new Map(),
  };
}

/** Clients in nobody's book (no order or quote with an active salesperson, and no
 *  active primary designer), plus clients with an open quote in nobody's pipeline. */
async function unassignedBookScope(): Promise<BookScope> {
  const activeStaff = await prisma.staffMember.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true, aliases: true },
  });
  const activeIds = activeStaff.map((staff) => staff.id);
  const hasOrder = { customerId: { not: null }, status: { in: [...BOOK_STATUSES] } };

  const salespersonNames = await prisma.salesOrder.groupBy({
    by: ["salesperson"],
    where: { ...hasOrder, salesperson: { not: null } },
  });
  const activeNames = salespersonNames
    .map((row) => row.salesperson)
    .filter((name): name is string => nameMatchesActiveStaff(name, activeStaff));

  const [allClients, ownedClients, assignedClients, openQuotes] = await Promise.all([
    prisma.salesOrder.groupBy({ by: ["customerId"], where: hasOrder }),
    prisma.salesOrder.groupBy({
      by: ["customerId"],
      where: {
        ...hasOrder,
        OR: [
          { salesPersonId: { in: activeIds } },
          { splitWithId: { in: activeIds } },
          { salesPersonId: null, salesperson: { in: activeNames } },
        ],
      },
    }),
    prisma.customer.findMany({
      where: { primaryDesigner: { isActive: true } },
      select: { id: true },
    }),
    prisma.salesOrder.findMany({
      where: { customerId: { not: null }, status: "QUOTE", pipelineArchivedAt: null },
      select: {
        customerId: true,
        salesPersonId: true,
        salesperson: true,
        customer: { select: { primaryDesignerId: true } },
      },
    }),
  ]);

  const ownedIds = new Set([
    ...ownedClients.map((row) => row.customerId),
    ...assignedClients.map((customer) => customer.id),
  ]);
  const ownerlessQuotes = new Map<number, number>();
  for (const quote of openQuotes) {
    if (quote.customerId === null || isQuoteOwned(quote, activeStaff)) continue;
    ownerlessQuotes.set(quote.customerId, (ownerlessQuotes.get(quote.customerId) ?? 0) + 1);
  }

  const clientIds = allClients
    .map((row) => row.customerId)
    .filter((id): id is number => id !== null && (!ownedIds.has(id) || ownerlessQuotes.has(id)));

  const namesPerClient = await prisma.salesOrder.groupBy({
    by: ["customerId", "salesperson"],
    where: { customerId: { in: clientIds }, status: { in: [...BOOK_STATUSES] } },
  });
  const workedWith = new Map<number, Set<string>>();
  for (const { customerId, salesperson } of namesPerClient) {
    if (customerId === null || !salesperson) continue;
    if (nameMatchesActiveStaff(salesperson, activeStaff)) continue;
    const names = workedWith.get(customerId) ?? new Set<string>();
    names.add(salesperson);
    workedWith.set(customerId, names);
  }

  return {
    orders: { customerId: { in: clientIds } },
    assignedIds: new Set(),
    openQuotes: ownerlessQuotes,
    workedWith,
  };
}

/** Typing a brand finds everyone who has bought it. */
function boughtBrandMatch(token: string): Prisma.CustomerWhereInput {
  return {
    salesOrders: {
      some: {
        status: { in: ["ORDER", "FULFILLED"] },
        lineItems: {
          some: { product: { vendor: { name: { contains: token, mode: "insensitive" } } } },
        },
      },
    },
  };
}

async function loadBookEntries(scope: BookScope, search: string): Promise<ClientBookEntry[]> {
  const inBook = { ...scope.orders, customerId: scope.orders.customerId ?? { not: null } };
  const [sold, quoted] = await Promise.all([
    prisma.salesOrder.groupBy({
      by: ["customerId"],
      where: { ...inBook, status: { in: ["ORDER", "FULFILLED"] } },
      _count: { _all: true },
      _max: { orderDate: true },
    }),
    prisma.salesOrder.groupBy({
      by: ["customerId"],
      where: { ...inBook, status: "QUOTE" },
    }),
  ]);

  const soldByCustomer = new Map(sold.map((row) => [row.customerId, row]));
  const bookIds = [
    ...new Set([...sold, ...quoted].map((row) => row.customerId)),
    ...scope.assignedIds,
  ].filter((id): id is number => id !== null);

  const searchFilter = buildSearchFilter(
    search,
    [
      "firstName",
      "lastName",
      "email",
      "phone",
      "clientProfile.searchText",
      "interactions.some.notes",
    ],
    boughtBrandMatch,
  );
  const [customers, notedCustomers] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: bookIds }, ...(searchFilter as Prisma.CustomerWhereInput) },
      select: { id: true, firstName: true, lastName: true, lifetimeSpend: true },
    }),
    prisma.customerInteraction.findMany({
      where: { customerId: { in: bookIds }, notes: { not: null } },
      distinct: ["customerId"],
      select: { customerId: true },
    }),
  ]);
  const withNotes = new Set(notedCustomers.map((row) => row.customerId));

  return customers
    .filter((customer) => !isCashSaleCustomer(customer))
    .map((customer) => {
      const soldRow = soldByCustomer.get(customer.id);
      return {
        customerId: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        lifetimeSpend: Number(customer.lifetimeSpend ?? 0),
        ordersWithStaff: soldRow?._count._all ?? 0,
        lastOrderWithStaff: soldRow?._max.orderDate ?? null,
        openQuotes: scope.openQuotes.get(customer.id) ?? 0,
        hasNotes: withNotes.has(customer.id),
      };
    });
}

/** Who a client last dealt with, so a manager can see where an unowned client came from. */
async function fetchLastSalespersonByCustomer(
  customerIds: number[],
): Promise<Map<number, string | null>> {
  const orders = await prisma.salesOrder.findMany({
    where: { customerId: { in: customerIds }, status: { in: [...BOOK_STATUSES] } },
    orderBy: [{ customerId: "asc" }, { orderDate: { sort: "desc", nulls: "last" } }],
    distinct: ["customerId"],
    select: { customerId: true, salesperson: true },
  });
  return new Map(
    orders.flatMap((order) =>
      order.customerId === null ? [] : [[order.customerId, order.salesperson] as const],
    ),
  );
}

async function fetchNotesByCustomer(customerIds: number[]): Promise<Map<number, ClientBookNote[]>> {
  const rows = await prisma.customerInteraction.findMany({
    where: { customerId: { in: customerIds }, notes: { not: null } },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      customerId: true,
      source: true,
      notes: true,
      startedAt: true,
      staffMember: { select: { displayName: true } },
      salesOrder: { select: { orderno: true } },
    },
  });

  const byCustomer = new Map<number, ClientBookNote[]>();
  for (const row of rows) {
    if (row.customerId === null || row.notes === null) continue;
    const list = byCustomer.get(row.customerId) ?? [];
    if (list.length < MAX_NOTES_PER_CLIENT) {
      list.push({
        id: row.id,
        source: row.source,
        notes: row.notes,
        startedAt: row.startedAt.toISOString(),
        staffName: row.staffMember.displayName,
        orderno: row.salesOrder?.orderno ?? null,
      });
    }
    byCustomer.set(row.customerId, list);
  }
  return byCustomer;
}

export async function fetchClientBook(
  staff: ClientBookStaff,
  options: ClientBookOptions,
  now: Date,
): Promise<ClientBookPage> {
  const scope = await staffBookScope(staff);
  const entries = await loadBookEntries(scope, options.search);
  const sorted = sortClientBook(filterClientBook(entries, options, now), options.sort);
  return loadBookPage(sorted, scope, options);
}

/** The no-owner clients these options match, plus who they all worked with. */
async function loadUnassignedEntries(options: ClientBookOptions, now: Date) {
  const scope = await unassignedBookScope();
  const entries = filterClientBook(await loadBookEntries(scope, options.search), options, now);
  const workedWithOptions = buildWorkedWithOptions(
    entries.map((entry) => entry.customerId),
    scope.workedWith,
    options.workedWith,
  );
  const matching = options.workedWith
    ? entries.filter((entry) => scope.workedWith.get(entry.customerId)?.has(options.workedWith))
    : entries;
  return { scope, matching, workedWithOptions };
}

/** Clients no one owns. Those with an ownerless open quote come first, since someone
 *  should be following up with them now. */
export async function fetchUnassignedClients(
  options: ClientBookOptions,
  now: Date,
): Promise<ClientBookPage> {
  const { scope, matching, workedWithOptions } = await loadUnassignedEntries(options, now);
  const sorted = sortClientBook(matching, options.sort);
  const withOpenQuotesFirst = [
    ...sorted.filter((entry) => entry.openQuotes > 0),
    ...sorted.filter((entry) => entry.openQuotes === 0),
  ];
  const page = await loadBookPage(withOpenQuotesFirst, scope, options);
  const lastSalesperson = await fetchLastSalespersonByCustomer(page.rows.map((row) => row.id));
  return {
    ...page,
    workedWithOptions,
    ownerlessQuoteCount: matching.reduce((sum, entry) => sum + entry.openQuotes, 0),
    rows: page.rows.map((row) => ({
      ...row,
      lastSalesperson: lastSalesperson.get(row.id) ?? null,
    })),
  };
}

/** The ids behind a bulk assign: exactly the clients the manager has on screen. */
export async function fetchUnassignedClientIds(
  options: ClientBookOptions,
  now: Date,
): Promise<number[]> {
  const { matching } = await loadUnassignedEntries(options, now);
  return matching.map((entry) => entry.customerId);
}

async function loadBookPage(
  sorted: ClientBookEntry[],
  scope: BookScope,
  options: ClientBookOptions,
): Promise<ClientBookPage> {
  const start = (options.page - 1) * CLIENT_BOOK_PAGE_SIZE;
  const pageEntries = sorted.slice(start, start + CLIENT_BOOK_PAGE_SIZE);
  const pageIds = pageEntries.map((entry) => entry.customerId);

  const [customers, background, notes] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: pageIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        lifetimeSpend: true,
        lifetimeOrderCount: true,
        customerLevel: true,
        peakCustomerLevel: true,
        departmentCount: true,
        lastOrderDate: true,
        clientProfile: true,
        // For the lead tier only. Wealth fields never leave this function.
        windfallEnrichment: {
          select: {
            wealthTier: true,
            recentMover: true,
            recentMortgage: true,
            recentlyDivorced: true,
            moneyInMotion: true,
            liquidityTrigger: true,
          },
        },
      },
    }),
    fetchClientBackground(pageIds),
    fetchNotesByCustomer(pageIds),
  ]);
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));

  const rows = pageEntries.flatMap((entry): ClientBookRow[] => {
    const customer = customerById.get(entry.customerId);
    if (!customer) return [];
    return [
      {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: callablePhone(customer.phone),
        email: mailableEmail(customer.email),
        leadTier: calculateLeadScore(leadScoreInputFromCustomer(customer)).tier,
        history: {
          lifetimeSpend: entry.lifetimeSpend,
          orderCount: customer.lifetimeOrderCount ?? 0,
          lastOrderDate: customer.lastOrderDate?.toISOString() ?? null,
          lastPurchase: null,
          brands: [],
          locations: [],
          ...background.get(customer.id),
        },
        ordersWithStaff: entry.ordersWithStaff,
        lastOrderWithStaff: entry.lastOrderWithStaff?.toISOString() ?? null,
        openQuotes: entry.openQuotes,
        profile: customer.clientProfile ? toClientProfileView(customer.clientProfile) : null,
        notes: notes.get(customer.id) ?? [],
        isAssigned: scope.assignedIds.has(customer.id),
        lastSalesperson: null,
      },
    ];
  });

  return { rows, total: sorted.length, workedWithOptions: [], ownerlessQuoteCount: 0 };
}

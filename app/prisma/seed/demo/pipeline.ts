// /app/prisma/seed/demo/pipeline.ts
//
// The front of the funnel: quotes that have not closed, leads that have not
// been worked, the record of customers walking in, and the B2B proposals that
// sit above all of it.
//
// This is the first card on the Sales hub and it rendered "No open quotes or
// leads." on a fresh clone, because the seed made orders and never made a
// QUOTE. Four screens were empty behind it -- Pipeline, the Quotes filter,
// Stale Quote Cleanup and Pipeline Opportunity -- and all four are about the
// same absent thing.
//
// What each piece is for, and why it is shaped this way:
//
//   QUOTES age deliberately. The Pipeline colours a quote green, amber or red
//     by how long it has sat, and Stale Quote Cleanup exists to find the ones
//     nobody chased. A batch of quotes all written yesterday exercises neither.
//     These are staggered 1-90 days back so every bucket has something in it.
//
//   LEADS carry a source, because the whole point of the board is that a
//     Mailchimp click and a walk-in are worked differently. Some are assigned
//     and some are not: an unassigned lead is what the "Assign" action exists
//     for, and a board where everything is already assigned cannot show it.
//
//   INTERACTIONS are the up-board and the follow-up history. Without them
//     every customer reads "No follow-up yet" and the designer rotation on the
//     dashboard shows "No one signed in". A few are left OPEN (isActive, no
//     endedAt) because somebody being with a customer right now is the state
//     the board is for.
//
//   PROPOSALS are the trade side -- a named project, a cover letter, line
//     items, and a status that moves. Seeded across DRAFT / SENT / ACCEPTED so
//     the filter has all three, and the accepted ones link to a real order.

import type {
  PrismaClient,
  LeadSource,
  LeadStatus,
  ProposalStatus,
  InteractionOutcome,
} from "@prisma/client";
import type { Rng } from "./rng";
import { chance, pick, randInt, round2, subRng } from "./rng";
import type { SeededCustomer } from "./customers";
import type { StaffSetup } from "./staff";
import type { StoreSetup } from "./locations";
import type { CatalogProduct } from "./catalog";

const SEED_ACTOR = "seed:demo";

const CLOSED_OUTCOMES: InteractionOutcome[] = [
  "BROWSING",
  "QUOTE_STARTED",
  "SALE_COMPLETED",
  "APPOINTMENT_SET",
  "SERVICE_CASE",
];

const PROJECT_NAMES = [
  "Lakeside Residence — full furnishing",
  "Harbourview Suites — model unit",
  "The Fairmont Lobby refresh",
  "Ridgeway Farmhouse — great room",
  "Stonebridge Club — dining refit",
  "Marchetti Residence — primary suite",
];

const LEAD_NOTES = [
  "Clicked through the spring lookbook twice.",
  "Walked the floor Saturday, took swatches home.",
  "Called about the sectional in the window.",
  "Referred by an existing trade account.",
  "Asked for a designer callback on the website form.",
];

const INTERACTION_NOTES = [
  "Walked the floor, took two fabric swatches.",
  "Came back with room measurements.",
  "Wanted to see the sectional in a performance weave.",
  "Following up on a quote from last month.",
  "Bringing a partner back at the weekend.",
];

export interface PipelineResult {
  quotesCreated: number;
  staleQuotes: number;
  leadsCreated: number;
  unassignedLeads: number;
  interactionsCreated: number;
  openInteractions: number;
  proposalsCreated: number;
}

export async function seedPipeline(
  prisma: PrismaClient,
  rng: Rng,
  customers: SeededCustomer[],
  staff: StaffSetup,
  stores: StoreSetup[],
  products: readonly CatalogProduct[],
  today: Date,
): Promise<PipelineResult> {
  const pRng = subRng(rng, "pipeline");
  const result: PipelineResult = {
    quotesCreated: 0,
    staleQuotes: 0,
    leadsCreated: 0,
    unassignedLeads: 0,
    interactionsCreated: 0,
    openInteractions: 0,
    proposalsCreated: 0,
  };

  if (customers.length === 0 || products.length === 0) return result;

  // Sellers, not just designers: the floor writes quotes too, and a pipeline
  // filtered to "mine" for a non-designer must not be empty.
  const sellers = [...staff.designers, ...staff.floorSellers, staff.admin, staff.superAdmin].filter(
    (s) => s.isActive,
  );

  // ---- open quotes -------------------------------------------------------
  for (let i = 0; i < 34; i++) {
    const seller = pick(pRng, sellers);
    const customer = pick(pRng, customers);
    const store = pick(pRng, stores);
    // Staggered so the Pipeline's urgency colours and Stale Quote Cleanup all
    // have something to show. Anything past ~45 days is what "stale" means.
    const daysOld = randInt(pRng, 1, 90);
    const quoteDate = new Date(today.getTime() - daysOld * 86_400_000);
    const lineCount = randInt(pRng, 1, 4);

    await prisma.salesOrder.create({
      data: {
        orderno: `Q-1${String(1000 + i)}`,
        status: "QUOTE",
        orderDate: quoteDate,
        customerId: customer.id,
        salesperson: seller.displayName,
        salesPersonId: seller.id,
        storeLocation: store.name,
        storeLocationId: store.id,
        createdBy: SEED_ACTOR,
        lineItems: {
          create: Array.from({ length: lineCount }, (_, n) => {
            const product = pick(pRng, products);
            const qty = randInt(pRng, 1, 2);
            return {
              lineNumber: n + 1,
              productId: product.id,
              productName: product.name,
              orderedQuantity: qty,
              netPrice: round2(product.baseRetail * qty),
              cost: round2(product.baseCost * qty),
              vatRate: 0,
              vatAmount: 0,
            };
          }),
        },
      },
    });
    result.quotesCreated += 1;
    if (daysOld > 45) result.staleQuotes += 1;
  }

  // ---- leads -------------------------------------------------------------
  const SOURCES: LeadSource[] = [
    "MAILCHIMP_CLICK",
    "MAILCHIMP_OPEN",
    "WALK_IN",
    "PHONE",
    "REFERRAL",
    "WEBSITE",
  ];

  for (let i = 0; i < 22; i++) {
    // A third stay unassigned -- that is what the Assign action is for, and a
    // board where everything is already assigned cannot demonstrate it.
    const assigned = i % 3 !== 0;
    const seller = pick(pRng, sellers);
    const customer = chance(pRng, 0.6) ? pick(pRng, customers) : null;
    const status: LeadStatus = assigned
      ? pick(pRng, ["ASSIGNED", "CONTACTED", "QUALIFIED"] as const)
      : "NEW";
    const raisedAt = new Date(today.getTime() - randInt(pRng, 0, 40) * 86_400_000);

    await prisma.lead.create({
      data: {
        source: pick(pRng, SOURCES),
        status,
        customerId: customer?.id ?? null,
        firstName: `Lead${i + 1}`,
        lastName: "Prospect",
        email: `lead${i + 1}@example.com`,
        phone: `860-555-1${String(100 + i)}`,
        notes: pick(pRng, LEAD_NOTES),
        assignedToId: assigned ? seller.id : null,
        assignedAt: assigned ? raisedAt : null,
        lastActionAt: raisedAt,
        created: raisedAt,
        createdBy: SEED_ACTOR,
      },
    });
    result.leadsCreated += 1;
    if (!assigned) result.unassignedLeads += 1;
  }

  // ---- interactions ------------------------------------------------------
  for (let i = 0; i < 60; i++) {
    const seller = pick(pRng, sellers);
    const store = pick(pRng, stores);
    const customer = chance(pRng, 0.8) ? pick(pRng, customers) : null;
    // Three are still open -- somebody is with a customer right now, which is
    // the state the up-board exists to show.
    const stillOpen = i < 3;
    const startedAt = stillOpen
      ? new Date(today.getTime() - randInt(pRng, 5, 90) * 60_000)
      : new Date(today.getTime() - randInt(pRng, 1, 60) * 86_400_000);

    await prisma.customerInteraction.create({
      data: {
        staffMemberId: seller.id,
        customerId: customer?.id ?? null,
        storeLocation: store.name,
        storeLocationId: store.id,
        source: pick(pRng, ["WALK_IN", "PHONE", "EMAIL", "APPOINTMENT"] as const),
        // An interaction still in progress has no outcome yet -- that is the
        // whole meaning of the field. (WITH_CUSTOMER and UP live on the
        // up-board enum, not this one; they describe the STAFF member's state,
        // not how the conversation ended.)
        outcome: stillOpen ? null : pick(pRng, CLOSED_OUTCOMES),
        notes: pick(pRng, INTERACTION_NOTES),
        startedAt,
        endedAt: stillOpen ? null : new Date(startedAt.getTime() + randInt(pRng, 10, 90) * 60_000),
        isActive: stillOpen,
        createdBy: SEED_ACTOR,
      },
    });
    result.interactionsCreated += 1;
    if (stillOpen) result.openInteractions += 1;
  }

  // ---- B2B proposals -----------------------------------------------------
  const tradeCustomers = customers.filter((c) => c.isTradeAccount);
  for (const [i, projectName] of PROJECT_NAMES.entries()) {
    const status: ProposalStatus = i < 2 ? "DRAFT" : i < 4 ? "SENT" : "ACCEPTED";
    const seller = pick(pRng, sellers);
    const customer = tradeCustomers.length > 0 ? pick(pRng, tradeCustomers) : pick(pRng, customers);
    const raisedAt = new Date(today.getTime() - randInt(pRng, 3, 60) * 86_400_000);

    await prisma.proposal.create({
      data: {
        proposalNumber: `PR-2026-${String(100 + i)}`,
        status,
        customerId: customer.id,
        projectName,
        salesPersonId: seller.id,
        coverLetter:
          "Thank you for the opportunity. The selections below reflect the brief, the site measurements and the lead times we discussed.",
        terms: "50% deposit on acceptance, balance on delivery. Lead times quoted from acceptance.",
        sentAt: status === "DRAFT" ? null : raisedAt,
        acceptedAt: status === "ACCEPTED" ? new Date(raisedAt.getTime() + 6 * 86_400_000) : null,
        expiresAt: new Date(raisedAt.getTime() + 30 * 86_400_000),
        created: raisedAt,
        createdBy: SEED_ACTOR,
        lineItems: {
          create: Array.from({ length: randInt(pRng, 3, 6) }, (_, n) => {
            const product = pick(pRng, products);
            return {
              itemName: product.name,
              cost: round2(product.baseCost),
              retailPrice: round2(product.baseRetail),
              sortOrder: n,
            };
          }),
        },
      },
    });
    result.proposalsCreated += 1;
  }

  return result;
}

// /app/prisma/seed/demo/serviceChecklists.ts
//
// GAP-11: service checklists. Three for the demo store, one switched off, so
// Settings > Service shows a list and the case page's picker leaves one out.
// The first few open cases are given a checklist, so a case page shows a
// checklist's tasks with their due dates.
//
// These go through lib/service/checklists.ts -- the code staff use -- so the
// seed cannot write a checklist the routes would refuse. No RNG draws: cases
// are taken by position, so nothing else the seed makes shifts.

import type { PrismaClient } from "@prisma/client";
import { applyChecklist, createChecklist } from "@/lib/service/checklists";
import { businessDayKey } from "@/lib/reports/businessDay";
import { SEED_TIME_ZONE } from "./config";

const SEED_ACTOR = "seed:demo";

/** A starting set a store edits, not names the code depends on. */
const CHECKLISTS = [
  {
    name: "Recliner mechanism repair",
    isActive: true,
    steps: [
      { title: "Photograph the mechanism and serial label", dueAfterDays: 0 },
      { title: "Order the replacement mechanism from the vendor", dueAfterDays: 1 },
      { title: "Book the technician once the part is in", dueAfterDays: null },
      { title: "Confirm the visit with the customer", dueAfterDays: null },
    ],
  },
  {
    name: "Delivery damage claim",
    isActive: true,
    steps: [
      { title: "Collect the customer's photos", dueAfterDays: 0 },
      { title: "File the claim with the vendor", dueAfterDays: 2 },
      { title: "Decide: repair on site or replace", dueAfterDays: 7 },
    ],
  },
  {
    name: "Leather touch-up (old process)",
    isActive: false,
    steps: [{ title: "Send the touch-up kit", dueAfterDays: 3 }],
  },
];

/** How many open cases are given the first active checklist. */
const CASES_GIVEN_ONE = 3;

export interface ServiceChecklistResult {
  checklistsCreated: number;
  casesGivenOne: number;
}

export async function seedServiceChecklists(prisma: PrismaClient): Promise<ServiceChecklistResult> {
  const created: { id: number }[] = [];
  for (const [sortOrder, checklist] of CHECKLISTS.entries()) {
    created.push(
      await prisma.$transaction((tx) =>
        createChecklist(
          tx,
          {
            ...checklist,
            sortOrder,
            steps: checklist.steps.map((s) => ({ ...s, description: null })),
          },
          SEED_ACTOR,
        ),
      ),
    );
  }

  const openCases = await prisma.serviceCase.findMany({
    where: { resolvedAt: null },
    orderBy: { id: "asc" },
    take: CASES_GIVEN_ONE,
    select: { id: true },
  });
  const today = businessDayKey(new Date(), SEED_TIME_ZONE);
  for (const serviceCase of openCases) {
    await prisma.$transaction((tx) =>
      applyChecklist(tx, serviceCase.id, created[0].id, { today, by: SEED_ACTOR }),
    );
  }

  return { checklistsCreated: created.length, casesGivenOne: openCases.length };
}

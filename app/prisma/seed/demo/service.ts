// /app/prisma/seed/demo/service.ts
//
// Service cases — the "something went wrong after the sale" workflow.
//
// The Service nav section is six pages, and every one of them was empty on a
// fresh clone because ServiceCase and its three lookup tables had no rows. So
// did Helpdesk and Time. A furniture retailer's after-sale problems are not a
// side feature; a demo that cannot show one is not showing the product.
//
// The lookup tables are seeded as CONFIG, not as constants: ServiceCaseType,
// ServiceCaseStatus and ServiceCasePriority are operator-editable tables with
// isActive/sortOrder, so these rows are a starting vocabulary a deployment
// edits, not a vocabulary the code depends on. Nothing here is referenced by
// name anywhere in src/.
//
// The case mix is shaped so the queue looks like a real one: mostly resolved,
// a working set open, and a couple that have been open long enough to be
// uncomfortable. A queue where every case is NEW tests nothing about a status
// filter, and a queue where every case is CLOSED shows an empty default view.

import type { PrismaClient } from "@prisma/client";
import type { Rng } from "./rng";
import { pick, randInt, subRng } from "./rng";
import type { SeededCustomer } from "./customers";
import type { StaffSetup } from "./staff";
import type { StoreSetup } from "./locations";

const SEED_ACTOR = "seed:demo";

/** Starting vocabulary. Operator-editable rows, not code constants. */
const TYPES = ["Warranty Claim", "Delivery Damage", "Missing Parts", "Repair Request", "Other"];
const PRIORITIES: { name: string; level: number; color: string }[] = [
  { name: "Low", level: 1, color: "#6B7280" },
  { name: "Normal", level: 2, color: "#2563EB" },
  { name: "High", level: 3, color: "#D97706" },
  { name: "Urgent", level: 4, color: "#DC2626" },
];
const STATUSES: { name: string; isClosed: boolean; color: string }[] = [
  { name: "New", isClosed: false, color: "#2563EB" },
  { name: "In Progress", isClosed: false, color: "#D97706" },
  { name: "Waiting on Vendor", isClosed: false, color: "#7C3AED" },
  { name: "Resolved", isClosed: true, color: "#059669" },
  { name: "Closed", isClosed: true, color: "#6B7280" },
];

const SUMMARIES = [
  "Sectional arrived with a torn seam on the chaise cushion",
  "Dining table delivered without the leaf extension",
  "Recliner mechanism sticks on the left side",
  "Finish scratched on the dresser top during delivery",
  "Bed rails missing from the shipment",
  "Sofa leg loose after two weeks of use",
  "Wrong fabric grade delivered on the accent chair",
  "Drawer glide broken on the nightstand",
];

export interface ServiceResult {
  typesCreated: number;
  casesCreated: number;
  openCases: number;
  notesCreated: number;
}

export async function seedService(
  prisma: PrismaClient,
  rng: Rng,
  customers: SeededCustomer[],
  staff: StaffSetup,
  stores: StoreSetup[],
  caseCount: number,
): Promise<ServiceResult> {
  const svcRng = subRng(rng, "service");
  const result: ServiceResult = {
    typesCreated: 0,
    casesCreated: 0,
    openCases: 0,
    notesCreated: 0,
  };

  const typeRows = [];
  for (const [i, name] of TYPES.entries()) {
    typeRows.push(
      await prisma.serviceCaseType.create({
        data: { name, sortOrder: i, createdBy: SEED_ACTOR },
      }),
    );
    result.typesCreated++;
  }
  const priorityRows = [];
  for (const [i, p] of PRIORITIES.entries()) {
    priorityRows.push(
      await prisma.serviceCasePriority.create({
        data: { ...p, sortOrder: i, createdBy: SEED_ACTOR },
      }),
    );
  }
  const statusRows = [];
  for (const [i, st] of STATUSES.entries()) {
    statusRows.push(
      await prisma.serviceCaseStatus.create({
        data: { ...st, sortOrder: i, createdBy: SEED_ACTOR },
      }),
    );
  }

  const openStatuses = statusRows.filter((s) => !s.isClosed);
  const closedStatuses = statusRows.filter((s) => s.isClosed);
  const assignees = staff.all.filter((s) => s.role === "MANAGER" || s.role === "WAREHOUSE");

  for (let i = 0; i < caseCount; i++) {
    // ~65% resolved. A queue that is all-open or all-closed exercises no filter
    // and shows an empty or overwhelming default view.
    const isClosed = randInt(svcRng, 1, 100) <= 65;
    const status = isClosed ? pick(svcRng, closedStatuses) : pick(svcRng, openStatuses);
    const customer = pick(svcRng, customers);
    const store = pick(svcRng, stores);
    const daysAgo = isClosed ? randInt(svcRng, 20, 400) : randInt(svcRng, 1, 45);
    const reported = new Date(Date.now() - daysAgo * 86_400_000);

    const serviceCase = await prisma.serviceCase.create({
      data: {
        caseNumber: `SC-${String(1000 + i)}`,
        typeId: pick(svcRng, typeRows).id,
        statusId: status.id,
        priorityId: pick(svcRng, priorityRows).id,
        summary: pick(svcRng, SUMMARIES),
        customerId: customer.id,
        storeLocationId: store.id,
        storeLocation: store.name,
        assignedToId: assignees.length > 0 ? pick(svcRng, assignees).id : null,
        resolvedAt: isClosed ? new Date(reported.getTime() + 5 * 86_400_000) : null,
        resolutionNotes: isClosed ? "Replacement part fitted on site; customer satisfied." : null,
        created: reported,
        createdBy: SEED_ACTOR,
      },
    });
    result.casesCreated++;
    if (!isClosed) result.openCases++;

    // An internal note on most cases — the case detail page is mostly a
    // timeline, and a timeline with one row does not look like one.
    const noteCount = randInt(svcRng, 1, 3);
    for (let n = 0; n < noteCount; n++) {
      const author = assignees.length > 0 ? pick(svcRng, assignees) : null;
      await prisma.serviceCaseNote.create({
        data: {
          caseId: serviceCase.id,
          authorId: author?.id ?? null,
          authorDisplayName: author?.displayName ?? null,
          note:
            n === 0
              ? "Photos received from the customer; raised with the vendor."
              : "Vendor confirmed the replacement part is in transit.",
          isInternal: true,
          created: new Date(reported.getTime() + (n + 1) * 86_400_000),
          createdBy: SEED_ACTOR,
        },
      });
      result.notesCreated++;
    }
  }

  return result;
}

// /app/src/lib/pipelineSearch.ts
//
// Where-clause for the pipeline search: names, and notes too, so typing "summer home"
// finds the clients someone noted that about. Kept pure so the token and owner-scoping
// logic is unit-testable; the handler supplies the viewer.
//
// A manager searches every open quote; a salesperson searches only their own (the same
// owner match the rest of the pipeline uses). Matching reuses buildSearchFilter, so "John
// Smith" matches firstName="John" + lastName="Smith". A quote matches on what its card can
// show: its own follow-ups, its archive note, the client's notes and Client Info.

import type { Prisma } from "@prisma/client";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { CLIENT_NOTE_SOURCE } from "@/lib/interactionSources";

export interface PipelineSearchViewer {
  canViewAll: boolean;
  staff: { id: number; displayName: string; aliases: string[] };
  includeArchived: boolean;
}

const SEARCH_FIELDS = [
  "customer.firstName",
  "customer.lastName",
  "customer.clientProfile.searchText",
  "interactions.some.notes",
  "pipelineNote",
];

function clientNoteMatch(token: string): Prisma.SalesOrderWhereInput {
  return {
    customer: {
      interactions: {
        some: {
          source: CLIENT_NOTE_SOURCE,
          notes: { contains: token, mode: "insensitive" },
        },
      },
    },
  };
}

/** Quotes that might be in a salesperson's pipeline: credited to them, or they're the
 *  client's primary designer. Callers then apply isQuoteInStaffPipeline, which also needs
 *  to know who else is active. */
export function staffPipelineWhere(staff: {
  id: number;
  displayName: string;
  aliases: string[];
}): Prisma.SalesOrderWhereInput[] {
  return [
    { salesPersonId: staff.id },
    ...[staff.displayName, ...staff.aliases].map((name) => ({
      salesPersonId: null,
      salesperson: { equals: name, mode: "insensitive" as const },
    })),
    { customer: { primaryDesignerId: staff.id } },
  ];
}

export function pipelineSearchWhere(
  search: string,
  viewer: PipelineSearchViewer,
): Prisma.SalesOrderWhereInput {
  const searchFilter = buildSearchFilter(search, SEARCH_FIELDS, clientNoteMatch);

  const where: Prisma.SalesOrderWhereInput = {
    status: "QUOTE",
    ...(viewer.includeArchived
      ? { pipelineArchivedAt: { not: null } }
      : { pipelineArchivedAt: null }),
    ...(searchFilter as Prisma.SalesOrderWhereInput),
  };

  if (!viewer.canViewAll) {
    where.OR = staffPipelineWhere(viewer.staff);
  }

  return where;
}

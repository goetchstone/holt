// /app/src/pages/api/sales/clients/index.ts
//
// GET a salesperson's client book, gated like the page it feeds. Everyone gets their
// own; sales.clients.manage opens anyone's with ?staffId=, or the clients no one owns
// with ?staffId=unassigned. Read-only; assigning a client is ./assign.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getAppSettings } from "@/lib/appSettings";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { businessDayKey } from "@/lib/reports/businessDay";
import {
  CLIENT_BOOK_PAGE_SIZE,
  parseClientBookOptions,
  readOutreachRules,
  type OutreachRules,
  UNASSIGNED_STAFF_ID,
  type WorkedWithOption,
} from "@/lib/clientBook";
import { CLIENT_OWNER_ROLES } from "@/lib/clientOwnership";
import {
  fetchClientBook,
  fetchUnassignedClients,
  type ClientBookPage,
  type ClientBookRow,
} from "@/lib/clientBookQuery";

interface StaffOption {
  id: number;
  displayName: string;
}

export interface ClientBookResponse {
  rows: ClientBookRow[];
  total: number;
  page: number;
  pageSize: number;
  // Null when listing clients no one owns.
  staff: StaffOption | null;
  // Empty unless the viewer may open other people's books.
  staffOptions: StaffOption[];
  // Who a client can be assigned to. Only filled when listing clients no one owns.
  assignOptions: StaffOption[];
  // Also only for that list.
  workedWithOptions: WorkedWithOption[];
  ownerlessQuoteCount: number;
  today: string;
  // Null until the store asks for suggestions in Settings.
  outreach: OutreachRules | null;
  // The viewer's own morning email: null when the store doesn't send one.
  morningEmailOn: boolean | null;
}

function findStaffOptions(where: Prisma.StaffMemberWhereInput): Promise<StaffOption[]> {
  return prisma.staffMember.findMany({
    where,
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
  });
}

export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: { holds: Record<string, boolean> },
) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!session.user?.email) return res.status(401).json({ error: "Unauthorized" });

  try {
    const viewer = await prisma.staffMember.findUnique({
      where: { email: session.user.email },
      select: { id: true, displayName: true, aliases: true, followUpEmailOff: true },
    });
    if (!viewer) return res.status(403).json({ error: "Staff record required" });

    const canViewAll = access.holds["sales.clients.manage"];
    const listsUnassigned = canViewAll && req.query.staffId === UNASSIGNED_STAFF_ID;
    const requestedStaffId = Number.parseInt(req.query.staffId as string, 10);
    const opensOtherBook =
      canViewAll && !Number.isNaN(requestedStaffId) && requestedStaffId !== viewer.id;
    const staff = opensOtherBook
      ? await prisma.staffMember.findUnique({
          where: { id: requestedStaffId },
          select: { id: true, displayName: true, aliases: true },
        })
      : viewer;
    if (!staff) return res.status(404).json({ error: "Staff member not found" });

    const options = parseClientBookOptions(req.query);
    const now = new Date();
    const loadPage = (): Promise<ClientBookPage> =>
      listsUnassigned ? fetchUnassignedClients(options, now) : fetchClientBook(staff, options, now);
    const [page, staffOptions, assignOptions] = await Promise.all([
      loadPage(),
      canViewAll ? findStaffOptions({ isActive: true }) : Promise.resolve([]),
      listsUnassigned
        ? findStaffOptions({ isActive: true, role: { in: [...CLIENT_OWNER_ROLES] } })
        : Promise.resolve([]),
    ]);

    const app = await getAppSettings();
    return res.status(200).json({
      ...page,
      today: businessDayKey(now, app.timezone),
      outreach: readOutreachRules(app),
      morningEmailOn: app.followUpEmailHour === null ? null : !viewer.followUpEmailOff,
      page: options.page,
      pageSize: CLIENT_BOOK_PAGE_SIZE,
      staff: listsUnassigned ? null : { id: staff.id, displayName: staff.displayName },
      staffOptions,
      assignOptions,
    });
  } catch (err) {
    logError("Failed to load client book", err);
    return res.status(500).json({ error: "Failed to load clients" });
  }
}

export default requirePermission("sales.lead", handler, { also: ["sales.clients.manage"] });

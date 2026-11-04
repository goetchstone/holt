// /app/src/pages/api/customers/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { logError } from "@/lib/logger";
import {
  CustomerInputError,
  assertIdentifiable,
  isDuplicateEmail,
  readContact,
} from "@/lib/customers/customerContact";
import { ReferralError, readReferral } from "@/lib/customers/referrals";

/** The columns the customer list sorts by. Anything else is refused, not written into the query. */
const SORTABLE = ["lastName", "firstName", "email"] as const;
/** The most rows one page returns; its callers ask for 10 or fewer. */
const MAX_PAGE_SIZE = 100;

/** GET: a page of customers, searched, sorted by one of SORTABLE. */
async function listCustomers(req: NextApiRequest, res: NextApiResponse) {
  const page = Math.max(Number.parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(req.query.limit as string) || 10, 1),
    MAX_PAGE_SIZE,
  );
  const searchTerm = (req.query.search as string) || "";
  // The column comes from SORTABLE, never from the request: the query used to
  // write any name it was sent into orderBy (CodeQL #24).
  const requested = (req.query.sortBy as string | undefined) || "lastName";
  const sortBy = SORTABLE.find((column) => column === requested);
  if (!sortBy) {
    return res.status(400).json({ error: `Customers can't be sorted by ${requested}.` });
  }
  const sortDirection: Prisma.SortOrder = req.query.sortDirection === "desc" ? "desc" : "asc";

  const skip = (page - 1) * limit;

  try {
    // Multi-token search: "John Smith" matches firstName=John AND lastName=Smith.
    const searchFilter = buildSearchFilter(searchTerm, [
      "firstName",
      "lastName",
      "email",
      "phone",
      "externalIds.some.externalId",
    ]);
    const whereClause: Prisma.CustomerWhereInput = (searchFilter ??
      {}) as Prisma.CustomerWhereInput;

    const customers = await prisma.customer.findMany({
      skip,
      take: limit,
      where: whereClause,
      include: {
        addresses: true,
        externalIds: true,
      },
      orderBy: {
        [sortBy]: sortDirection,
      },
    });

    const totalCustomers = await prisma.customer.count({ where: whereClause });

    return res.status(200).json({
      data: customers,
      totalPages: Math.ceil(totalCustomers / limit),
    });
  } catch (error) {
    logError("List customers failed", error);
    return res.status(500).json({ error: "Failed to fetch customers" });
  }
}

/** POST: a new customer, from what a new-customer form sets. */
async function createCustomer(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const userEmail = session.user.email;
  // Only what a new-customer form sets: contact details and how they heard of
  // the store (lib/customers/customerContact.ts). Store credit, AR, trade and
  // tax status each have their own route and permission.
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const contact = readContact(body);
    assertIdentifiable(contact);
    const referral = await readReferral(prisma, body, null);
    const customer = await prisma.customer.create({
      data: { ...contact, ...referral, createdBy: userEmail },
    });
    return res.status(201).json(customer);
  } catch (error) {
    if (error instanceof CustomerInputError || error instanceof ReferralError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (isDuplicateEmail(error)) {
      return res.status(409).json({ error: "Another customer already has that email." });
    }
    logError("Create customer failed", error);
    return res.status(500).json({ error: "Failed to create customer" });
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") return listCustomers(req, res);
  if (req.method === "POST") return createCustomer(req, res, session);
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requirePermission("customer.write", handler);

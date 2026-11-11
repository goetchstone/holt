// /app/src/pages/api/customers/[id]/index.ts
//
// One customer. GET (View customers) is the record with its history; PUT (Edit
// customers) changes contact details and how they heard of the store (GAP-08).
// The edit form called PUT here from the start, and this route answered only
// GET, so a customer's name, email or phone could not be changed (found
// 2026-11-01). Per-method gates follow tenders/index.ts.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { activeStaffRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { computeBalance } from "@/lib/paymentService";
import {
  CustomerInputError,
  isDuplicateEmail,
  readContact,
  textConsentChange,
} from "@/lib/customers/customerContact";
import { getAppSettings } from "@/lib/appSettings";
import { toE164 } from "@/lib/sms/phone";
import { ReferralError, readReferral } from "@/lib/customers/referrals";

// Wealth enrichment data (net worth, wealth tier, lifestyle signals)
// lives on Customer via the `windfallEnrichment` relation. Only ADMIN
// and MARKETING may see wealth fields — everyone else gets the customer
// record with the enrichment relation stripped out server-side.
// SUPER_ADMIN (owner role above ADMIN) sees wealth fields too.
const WEALTH_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "MARKETING"]);

function customerIdOf(req: NextApiRequest): number | null {
  const id = Number.parseInt(String(req.query.id));
  return Number.isNaN(id) ? null : id;
}

async function handleGet(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const customerId = customerIdOf(req);
  if (customerId == null) return res.status(400).json({ error: "Invalid customer ID." });
  try {
    const role = (await activeStaffRole(session as { user?: { id?: string | null } | null })) ?? "";
    const canSeeWealth = WEALTH_ROLES.has(role);

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        addresses: true,
        externalIds: true,
        tradeTier: true,
        taxExemptReason: { select: { id: true, name: true } },
        referralSource: { select: { id: true, name: true, isActive: true } },
        referredBy: { select: { id: true, firstName: true, lastName: true } },
        windfallEnrichment: canSeeWealth,
        salesOrders: {
          include: {
            // The detail view sums netPrice and vatAmount; what the store
            // paid for each line is not part of a customer record.
            lineItems: { omit: { cost: true } },
            payments: true,
          },
          orderBy: {
            orderDate: "desc",
          },
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ error: "Customer not found." });
    }

    // A STOP is on the number, not the customer (SmsOptOut).
    const { locale } = await getAppSettings();
    const phone = toE164(customer.phone, locale);
    const optOut = phone
      ? await prisma.smsOptOut.findUnique({ where: { phone }, select: { optedOutAt: true } })
      : null;
    return res.status(200).json({
      ...customer,
      // Each order's total and paid by the register's rule (only lines still owed, only
      // settled payments, refunds out), worked out here so the screen doesn't redo it.
      salesOrders: customer.salesOrders.map((order) => {
        const { totalDue, totalPaid } = computeBalance(order.lineItems, order.payments);
        return { ...order, calculatedOrderTotal: totalDue, calculatedTotalPaid: totalPaid };
      }),
      textableNumber: phone,
      smsOptedOutAt: optOut?.optedOutAt ?? null,
    });
  } catch (error) {
    logError("Fetch customer details failed", error, { customerId });
    return res.status(500).json({ error: "Failed to fetch customer details." });
  }
}

async function handlePut(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const customerId = customerIdOf(req);
  if (customerId == null) return res.status(400).json({ error: "Invalid customer ID." });
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const current = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, referralSourceId: true, smsConsentAt: true },
    });
    if (!current) return res.status(404).json({ error: "Customer not found." });
    const contact = readContact(body);
    const referral = await readReferral(prisma, body, current);
    const actor = session.user?.email ?? null;
    const updated = await prisma.customer.update({
      where: { id: customerId },
      data: {
        ...contact,
        ...referral,
        ...textConsentChange(body.textConsent, current, actor),
        updatedBy: actor,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        autoMessagesOptOut: true,
        preferredChannel: true,
        smsConsentAt: true,
        smsConsentBy: true,
        referralSourceId: true,
        referredByCustomerId: true,
      },
    });
    return res.status(200).json(updated);
  } catch (error) {
    if (error instanceof CustomerInputError || error instanceof ReferralError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (isDuplicateEmail(error)) {
      return res.status(409).json({ error: "Another customer already has that email." });
    }
    logError("Update customer failed", error, { customerId });
    return res.status(500).json({ error: "Failed to save the customer." });
  }
}

/** Exported for integration tests, which call each method's body without the gate. */
export const handlers = { GET: handleGet, PUT: handlePut };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return requirePermission("customer.read", handleGet)(req, res);
  if (req.method === "PUT") return requirePermission("customer.write", handlePut)(req, res);
  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

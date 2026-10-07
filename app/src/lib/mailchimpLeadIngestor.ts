// /app/src/lib/mailchimpLeadIngestor.ts
//
// Pure-ish lead-ingestion logic used by both the automated orchestrator and
// the manual "Generate from Campaign" button. Converts MailchimpActivity
// rows into Lead rows with dedup + auto-assignment.
//
// Rules:
//   - Click → always eligible for lead creation.
//   - Open → only eligible if the customer is high-value (peak level >= 3
//     OR wealth tier HIGH/VERY_HIGH/ULTRA_HIGH). Opens are noisier than
//     clicks so we only treat them as an opportunity signal for customers
//     we already know are valuable.
//   - Dedup on email: if an ACTIVE lead (NEW | ASSIGNED | CONTACTED) already
//     exists for the email, don't create a duplicate. Bump `lastActionAt`
//     and refresh sourceDetail instead.
//   - Auto-assign: if the email matches a customer with a primaryDesigner,
//     set assignedToId and move status to ASSIGNED.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const ACTIVE_STATUSES = ["NEW", "ASSIGNED", "CONTACTED"] as const;
const HIGH_WEALTH_TIERS = new Set(["HIGH", "VERY_HIGH", "ULTRA_HIGH"]);
const HIGH_PEAK_LEVEL_MIN = 3; // 3 = High Value, 4 = VIP

export interface IngestOptions {
  // Only process activity created after this timestamp. Pass the previous
  // run's finishedAt to get an efficient incremental run.
  sinceTimestamp?: Date | null;
  // Optional: restrict to a single campaign (used by the manual
  // "Generate from Campaign" button).
  campaignId?: string;
}

export interface IngestResult {
  leadsCreated: number;
  leadsUpdated: number;
  activitiesConsidered: number;
  skippedLowValueOpens: number;
}

type Tx = Pick<PrismaClient, "mailchimpActivity" | "customer" | "lead" | "mailchimpCampaign">;

export async function ingestNewMailchimpActivityAsLeads(
  opts: IngestOptions = {},
  client: Tx = defaultPrisma,
): Promise<IngestResult> {
  const { sinceTimestamp, campaignId } = opts;

  // Fetch relevant activity. `created` (DB insert time) is what matters for
  // "new since last run" — the activity.timestamp is when Mailchimp recorded
  // the action, which could be older.
  const activities = await client.mailchimpActivity.findMany({
    where: {
      ...(sinceTimestamp ? { created: { gt: sinceTimestamp } } : {}),
      ...(campaignId ? { campaignId } : {}),
      // Only engagement signals — ignore bounce/unsubscribe for lead creation.
      action: { in: ["open", "click"] },
    },
    select: {
      id: true,
      email: true,
      action: true,
      campaignId: true,
      customerId: true,
      timestamp: true,
    },
    orderBy: { timestamp: "desc" },
  });

  if (activities.length === 0) {
    return { leadsCreated: 0, leadsUpdated: 0, activitiesConsidered: 0, skippedLowValueOpens: 0 };
  }

  // Collapse to one "best" activity per email — prefer click over open,
  // then most recent. Reduces lead-churn when one email has dozens of rows.
  const byEmail = new Map<
    string,
    { email: string; action: string; campaignId: string; customerId: number | null }
  >();
  for (const a of activities) {
    if (!a.email) continue;
    const prior = byEmail.get(a.email);
    if (!prior) {
      byEmail.set(a.email, {
        email: a.email,
        action: a.action,
        campaignId: a.campaignId,
        customerId: a.customerId,
      });
    } else if (prior.action === "open" && a.action === "click") {
      // upgrade
      byEmail.set(a.email, {
        email: a.email,
        action: a.action,
        campaignId: a.campaignId,
        customerId: a.customerId,
      });
    }
  }

  // Campaign title lookup for sourceDetail
  const campaignIds = Array.from(new Set(Array.from(byEmail.values()).map((v) => v.campaignId)));
  const campaigns = await client.mailchimpCampaign.findMany({
    where: { id: { in: campaignIds } },
    select: { id: true, subject: true, name: true },
  });
  const campaignSubject = new Map(campaigns.map((c) => [c.id, c.subject ?? c.name ?? c.id]));

  // Fetch customers by email (in one round-trip) to decide open-eligibility
  // and find primaryDesigner for auto-assignment.
  const emails = Array.from(byEmail.keys());
  const customers = await client.customer.findMany({
    where: { email: { in: emails } },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      peakCustomerLevel: true,
      primaryDesignerId: true,
      windfallEnrichment: { select: { wealthTier: true } },
    },
  });
  const customerByEmail = new Map(
    customers.filter((c) => c.email).map((c) => [c.email as string, c]),
  );

  // Fetch existing ACTIVE leads for these emails (dedup source of truth)
  const existingLeads = await client.lead.findMany({
    where: {
      email: { in: emails },
      status: { in: ACTIVE_STATUSES as unknown as ("NEW" | "ASSIGNED" | "CONTACTED")[] },
    },
    select: { id: true, email: true, sourceDetail: true },
  });
  const activeLeadByEmail = new Map<string, (typeof existingLeads)[number]>();
  for (const l of existingLeads) {
    if (l.email) activeLeadByEmail.set(l.email, l);
  }

  let leadsCreated = 0;
  let leadsUpdated = 0;
  let skippedLowValueOpens = 0;

  for (const entry of byEmail.values()) {
    const customer = customerByEmail.get(entry.email);
    const isClick = entry.action === "click";

    if (!isClick) {
      // Open — gate on value
      const peak = customer?.peakCustomerLevel ?? 0;
      const wealth = customer?.windfallEnrichment?.wealthTier ?? null;
      const valuable =
        peak >= HIGH_PEAK_LEVEL_MIN || (wealth !== null && HIGH_WEALTH_TIERS.has(wealth));
      if (!valuable) {
        skippedLowValueOpens++;
        continue;
      }
    }

    const sourceDetail = campaignSubject.get(entry.campaignId) ?? entry.campaignId;
    const existingLead = activeLeadByEmail.get(entry.email);

    if (existingLead) {
      // Bump — one SQL UPDATE. Preserves status, assignment, notes.
      await client.lead.update({
        where: { id: existingLead.id },
        data: {
          sourceDetail:
            existingLead.sourceDetail && existingLead.sourceDetail !== sourceDetail
              ? sourceDetail
              : (existingLead.sourceDetail ?? sourceDetail),
          lastActionAt: new Date(),
        },
      });
      leadsUpdated++;
      continue;
    }

    // Create a new lead
    const isAssignedToDesigner = !!customer?.primaryDesignerId;
    await client.lead.create({
      data: {
        source: isClick ? "MAILCHIMP_CLICK" : "MAILCHIMP_OPEN",
        status: isAssignedToDesigner ? "ASSIGNED" : "NEW",
        email: entry.email,
        firstName: customer?.firstName ?? null,
        lastName: customer?.lastName ?? null,
        phone: customer?.phone ?? null,
        customerId: customer?.id ?? null,
        campaignId: entry.campaignId,
        sourceDetail,
        assignedToId: customer?.primaryDesignerId ?? null,
        assignedAt: isAssignedToDesigner ? new Date() : null,
        lastActionAt: new Date(),
        createdBy: "auto:mailchimp",
      },
    });
    leadsCreated++;
  }

  logger.info("ingestNewMailchimpActivityAsLeads complete", {
    activitiesConsidered: activities.length,
    emailsCollapsed: byEmail.size,
    leadsCreated,
    leadsUpdated,
    skippedLowValueOpens,
  });

  return {
    leadsCreated,
    leadsUpdated,
    activitiesConsidered: activities.length,
    skippedLowValueOpens,
  };
}

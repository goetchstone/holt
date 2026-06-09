// /app/src/pages/api/leads/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { calculateLeadScore } from "@/lib/leadScore";
import { leadTemperature, daysSinceLastAction } from "@/lib/leadHousekeeping";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const userEmail = session.user.email;
  const role = (session as { role?: string }).role;
  const canSeeWealth = role === "ADMIN" || role === "SUPER_ADMIN" || role === "MARKETING";
  const canSeeNumericScore =
    role === "ADMIN" || role === "SUPER_ADMIN" || role === "MANAGER" || role === "MARKETING";

  if (req.method === "GET") {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const where: Prisma.LeadWhereInput = {};

    if (req.query.status) {
      where.status = req.query.status as Prisma.EnumLeadStatusFilter;
    }
    if (req.query.assignedToId) {
      where.assignedToId = Number.parseInt(req.query.assignedToId as string);
    }
    if (req.query.source) {
      where.source = req.query.source as Prisma.EnumLeadSourceFilter;
    }
    if (req.query.campaignId) {
      where.campaignId = req.query.campaignId as string;
    }

    try {
      const [leads, total] = await Promise.all([
        prisma.lead.findMany({
          where,
          skip,
          take: limit,
          orderBy: [{ lastActionAt: "desc" }, { created: "desc" }],
          include: {
            customer: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                lifetimeSpend: true,
                lifetimeOrderCount: true,
                customerLevel: true,
                peakCustomerLevel: true,
                departmentCount: true,
                lastOrderDate: true,
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
            },
            assignedTo: {
              select: { id: true, displayName: true },
            },
            salesOrder: {
              select: { id: true, orderno: true },
            },
          },
        }),
        prisma.lead.count({ where }),
      ]);

      // Batch-enrich: customer order stats and campaign subjects
      const customerIds = [
        ...new Set(leads.filter((l) => l.customerId).map((l) => l.customerId as number)),
      ];
      const campaignIds = [
        ...new Set(leads.filter((l) => l.campaignId).map((l) => l.campaignId as string)),
      ];

      // Order counts and totals per customer
      const orderStatsMap = new Map<
        number,
        { orderCount: number; totalSpend: number; lastSalesperson: string | null }
      >();

      if (customerIds.length > 0) {
        const orderAggs = await prisma.salesOrder.groupBy({
          by: ["customerId"],
          where: { customerId: { in: customerIds } },
          _count: { id: true },
        });

        // Sum line item netPrice per customer for total spend
        const spendAggs = await prisma.orderLineItem.groupBy({
          by: ["salesOrderId"],
          where: {
            salesOrder: { customerId: { in: customerIds } },
          },
          _sum: { netPrice: true },
        });

        // Map salesOrderId to customerId for spend aggregation
        const orderToCustomer = new Map<number, number>();
        const ordersForCustomers = await prisma.salesOrder.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true, customerId: true },
        });
        for (const o of ordersForCustomers) {
          if (o.customerId) orderToCustomer.set(o.id, o.customerId);
        }

        const spendByCustomer = new Map<number, number>();
        for (const agg of spendAggs) {
          const custId = orderToCustomer.get(agg.salesOrderId);
          if (custId) {
            spendByCustomer.set(
              custId,
              (spendByCustomer.get(custId) || 0) + Number(agg._sum.netPrice || 0),
            );
          }
        }

        // Most recent order per customer for last salesperson
        const latestOrders = await prisma.salesOrder.findMany({
          where: { customerId: { in: customerIds } },
          orderBy: { orderDate: "desc" },
          distinct: ["customerId"],
          select: {
            customerId: true,
            salesperson: true,
            salesPerson: { select: { displayName: true } },
          },
        });

        const lastSalespersonMap = new Map<number, string | null>();
        for (const o of latestOrders) {
          if (o.customerId) {
            lastSalespersonMap.set(
              o.customerId,
              o.salesPerson?.displayName || o.salesperson || null,
            );
          }
        }

        for (const agg of orderAggs) {
          if (agg.customerId) {
            orderStatsMap.set(agg.customerId, {
              orderCount: agg._count.id,
              totalSpend: spendByCustomer.get(agg.customerId) || 0,
              lastSalesperson: lastSalespersonMap.get(agg.customerId) || null,
            });
          }
        }
      }

      // Campaign subjects by campaignId
      const campaignSubjectMap = new Map<string, string | null>();
      if (campaignIds.length > 0) {
        const campaigns = await prisma.mailchimpCampaign.findMany({
          where: { id: { in: campaignIds } },
          select: { id: true, subject: true, name: true },
        });
        for (const c of campaigns) {
          campaignSubjectMap.set(c.id, c.subject || c.name || null);
        }
      }

      // Recent-engagement batch: for each lead's email, count clicks/opens
      // in the last 30 days and find the most recent open/click.
      const engagementByEmail = new Map<
        string,
        { lastOpenAt: Date | null; lastClickAt: Date | null; campaignCount30d: number }
      >();
      const emails = Array.from(new Set(leads.map((l) => l.email).filter((e): e is string => !!e)));
      if (emails.length > 0) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
        const activity = await prisma.mailchimpActivity.findMany({
          where: {
            email: { in: emails },
            action: { in: ["open", "click"] },
            timestamp: { gte: thirtyDaysAgo },
          },
          select: { email: true, action: true, timestamp: true, campaignId: true },
          orderBy: { timestamp: "desc" },
        });
        for (const a of activity) {
          if (!a.email) continue;
          const current = engagementByEmail.get(a.email) ?? {
            lastOpenAt: null,
            lastClickAt: null,
            campaignCount30d: 0,
          };
          if (a.action === "open" && (!current.lastOpenAt || a.timestamp > current.lastOpenAt)) {
            current.lastOpenAt = a.timestamp;
          }
          if (a.action === "click" && (!current.lastClickAt || a.timestamp > current.lastClickAt)) {
            current.lastClickAt = a.timestamp;
          }
          engagementByEmail.set(a.email, current);
        }
        // Distinct campaign count in window, per email
        const campaignCounts = new Map<string, Set<string>>();
        for (const a of activity) {
          if (!a.email) continue;
          const set = campaignCounts.get(a.email) ?? new Set<string>();
          set.add(a.campaignId);
          campaignCounts.set(a.email, set);
        }
        for (const [email, set] of campaignCounts.entries()) {
          const existing = engagementByEmail.get(email);
          if (existing) existing.campaignCount30d = set.size;
        }
      }

      const now = new Date();
      function suggestedAction(
        lead: (typeof leads)[number],
        daysSince: number,
      ): { key: string; label: string } | null {
        if (lead.status === "NEW" && !lead.assignedToId) {
          return { key: "assign", label: "Assign to a designer" };
        }
        if (lead.status === "ASSIGNED" && daysSince >= 7) {
          return { key: "nudge", label: "Needs follow-up" };
        }
        if (["NEW", "ASSIGNED"].includes(lead.status) && daysSince >= 14) {
          return { key: "decide", label: "Mark lost or pin to keep" };
        }
        return null;
      }

      // Merge enrichment data onto each lead
      const enriched = leads.map((lead) => {
        const stats = lead.customerId ? orderStatsMap.get(lead.customerId) : undefined;
        const engagement = lead.email ? engagementByEmail.get(lead.email) : undefined;

        // Score uses the customer's lifetime fields when available, else
        // zero-ish input → tier stays NEW.
        const wf = lead.customer?.windfallEnrichment;
        const scoreInput = lead.customer
          ? {
              lifetimeSpend: Number(lead.customer.lifetimeSpend ?? 0),
              lifetimeOrderCount: lead.customer.lifetimeOrderCount,
              customerLevel: lead.customer.customerLevel,
              peakCustomerLevel: lead.customer.peakCustomerLevel,
              departmentCount: lead.customer.departmentCount,
              lastOrderDate: lead.customer.lastOrderDate,
              wealthTier: wf?.wealthTier,
              recentMover: wf?.recentMover,
              recentMortgage: wf?.recentMortgage,
              recentlyDivorced: wf?.recentlyDivorced,
              moneyInMotion: wf?.moneyInMotion,
              liquidityTrigger: wf?.liquidityTrigger,
            }
          : {};
        const score = calculateLeadScore(scoreInput);

        const temp = leadTemperature(lead.lastActionAt ?? lead.created);
        const daysSince = daysSinceLastAction(lead.lastActionAt ?? lead.created, now);

        // Strip customer wealth field from output for designers
        const customerOut = lead.customer
          ? {
              id: lead.customer.id,
              firstName: lead.customer.firstName,
              lastName: lead.customer.lastName,
              email: lead.customer.email,
            }
          : null;

        return {
          ...lead,
          customer: customerOut,
          isExistingCustomer: !!lead.customerId,
          hasOrders: (stats?.orderCount ?? 0) > 0,
          orderCount: stats?.orderCount ?? 0,
          totalSpend: stats?.totalSpend ?? 0,
          lastSalesperson: stats?.lastSalesperson ?? null,
          campaignSubject: lead.campaignId
            ? (campaignSubjectMap.get(lead.campaignId) ?? null)
            : null,
          // Intelligence layer
          leadTier: score.tier, // visible to all
          ...(canSeeNumericScore ? { leadScore: score.score } : {}),
          ...(canSeeWealth
            ? { wealthTier: lead.customer?.windfallEnrichment?.wealthTier ?? null }
            : {}),
          recentEngagement: engagement
            ? {
                lastOpenAt: engagement.lastOpenAt,
                lastClickAt: engagement.lastClickAt,
                campaignCount30d: engagement.campaignCount30d,
              }
            : { lastOpenAt: null, lastClickAt: null, campaignCount30d: 0 },
          staleness: temp, // "active" | "going_stale" | "expired"
          daysSinceLastAction: isFinite(daysSince) ? daysSince : null,
          suggestedAction: suggestedAction(lead, isFinite(daysSince) ? daysSince : 999),
        };
      });

      return res.json({
        data: enriched,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      logError("Failed to fetch leads", err);
      return res.status(500).json({ error: "Failed to fetch leads" });
    }
  }

  if (req.method === "POST") {
    try {
      const { email, firstName, lastName, phone, source, notes, customerId } = req.body;

      if (!source) {
        return res.status(400).json({ error: "source is required" });
      }

      const data: Prisma.LeadCreateInput = {
        source,
        email: email || null,
        firstName: firstName || null,
        lastName: lastName || null,
        phone: phone || null,
        notes: notes || null,
        createdBy: userEmail,
      };

      if (customerId) {
        data.customer = { connect: { id: customerId } };

        // Auto-assign to primary designer if customer has one
        const customer = await prisma.customer.findUnique({
          where: { id: customerId },
          select: { primaryDesignerId: true },
        });
        if (customer?.primaryDesignerId) {
          data.assignedTo = { connect: { id: customer.primaryDesignerId } };
          data.assignedAt = new Date();
          data.status = "ASSIGNED";
        }
      }

      const lead = await prisma.lead.create({
        data,
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          assignedTo: {
            select: { id: true, displayName: true },
          },
        },
      });

      return res.status(201).json(lead);
    } catch (err) {
      logError("Failed to create lead", err);
      return res.status(500).json({ error: "Failed to create lead" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}

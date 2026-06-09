// /app/__tests__/integration/mailchimpLeadIngestor.integration.test.ts
//
// Phase 0.6.3 conversion: mailchimp lead-ingestor orchestration.
// Replaces the C+ mocked-Prisma block in
// __tests__/mailchimpLeadIngestor.test.ts with real-DB integration
// tests.
//
// Why this matters: the ingestor decides whether a Mailchimp open/click
// becomes a lead. A bug here either floods the leads board with noise
// (every open) or misses real signals (every high-value engagement).
// Mocked tests confirmed the function CALLS the right Prisma methods;
// this file confirms the SQL filter actually selects the right rows
// against a real schema with FK constraints.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { ingestNewMailchimpActivityAsLeads } from "@/lib/mailchimpLeadIngestor";

const NOW = new Date("2026-04-22T10:00:00Z");

async function seedCampaign(id: string, subject?: string) {
  return prisma.mailchimpCampaign.create({
    data: { id, subject: subject ?? null, name: subject ?? null },
  });
}

async function seedCustomer(opts: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  peakCustomerLevel?: number | null;
  primaryDesignerId?: number | null;
  wealthTier?: "AFFLUENT" | "HIGH" | "VERY_HIGH" | "ULTRA_HIGH" | null;
}) {
  const customer = await prisma.customer.create({
    data: {
      email: opts.email,
      firstName: opts.firstName ?? null,
      lastName: opts.lastName ?? null,
      peakCustomerLevel: opts.peakCustomerLevel ?? null,
      primaryDesignerId: opts.primaryDesignerId ?? null,
    },
  });
  if (opts.wealthTier) {
    await prisma.windfallEnrichment.create({
      data: {
        customerId: customer.id,
        wealthTier: opts.wealthTier,
      },
    });
  }
  return customer;
}

async function seedActivity(opts: {
  email: string;
  action: "open" | "click" | "bounce";
  campaignId: string;
  customerId?: number | null;
  timestamp?: Date;
}) {
  return prisma.mailchimpActivity.create({
    data: {
      email: opts.email,
      action: opts.action,
      campaignId: opts.campaignId,
      customerId: opts.customerId ?? null,
      timestamp: opts.timestamp ?? NOW,
    },
  });
}

async function seedDesigner(displayName: string) {
  return prisma.staffMember.create({
    data: {
      displayName,
      email: `${displayName.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      role: "DESIGNER",
    },
  });
}

describe("ingestNewMailchimpActivityAsLeads (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a lead for a click on an unknown email", async () => {
    await seedCampaign("camp-1", "Spring Sale");
    await seedActivity({
      email: "stranger@example.com",
      action: "click",
      campaignId: "camp-1",
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);

    expect(result.leadsCreated).toBe(1);
    expect(result.leadsUpdated).toBe(0);
    const lead = await prisma.lead.findFirst({ where: { email: "stranger@example.com" } });
    expect(lead).not.toBeNull();
    expect(lead?.source).toBe("MAILCHIMP_CLICK");
    expect(lead?.status).toBe("NEW"); // no customer → no auto-assign
    expect(lead?.sourceDetail).toBe("Spring Sale");
  });

  it("skips opens for customers who are not high-value", async () => {
    await seedCampaign("camp-1");
    const customer = await seedCustomer({
      email: "browsing@example.com",
      peakCustomerLevel: 1,
    });
    await seedActivity({
      email: "browsing@example.com",
      action: "open",
      campaignId: "camp-1",
      customerId: customer.id,
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);

    expect(result.leadsCreated).toBe(0);
    expect(result.skippedLowValueOpens).toBe(1);
    const leads = await prisma.lead.count();
    expect(leads).toBe(0);
  });

  it("creates a lead for an open from a peak-VIP customer", async () => {
    await seedCampaign("camp-1");
    const customer = await seedCustomer({
      email: "vip@example.com",
      firstName: "Jane",
      lastName: "Doe",
      peakCustomerLevel: 4,
    });
    await seedActivity({
      email: "vip@example.com",
      action: "open",
      campaignId: "camp-1",
      customerId: customer.id,
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);

    expect(result.leadsCreated).toBe(1);
    const lead = await prisma.lead.findFirst({ where: { email: "vip@example.com" } });
    expect(lead?.source).toBe("MAILCHIMP_OPEN");
    expect(lead?.firstName).toBe("Jane");
  });

  it("creates a lead for an open from a HIGH-wealth customer", async () => {
    await seedCampaign("camp-1");
    const customer = await seedCustomer({
      email: "rich@example.com",
      peakCustomerLevel: 1,
      wealthTier: "VERY_HIGH",
    });
    await seedActivity({
      email: "rich@example.com",
      action: "open",
      campaignId: "camp-1",
      customerId: customer.id,
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);
    expect(result.leadsCreated).toBe(1);
  });

  it("auto-assigns to the customer's primary designer when creating", async () => {
    await seedCampaign("camp-1");
    const designer = await seedDesigner("Test Designer");
    const customer = await seedCustomer({
      email: "mine@example.com",
      primaryDesignerId: designer.id,
    });
    await seedActivity({
      email: "mine@example.com",
      action: "click",
      campaignId: "camp-1",
      customerId: customer.id,
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);

    expect(result.leadsCreated).toBe(1);
    const lead = await prisma.lead.findFirst({ where: { email: "mine@example.com" } });
    expect(lead?.status).toBe("ASSIGNED");
    expect(lead?.assignedToId).toBe(designer.id);
    expect(lead?.assignedAt).not.toBeNull();
  });

  it("updates an existing active lead instead of creating a duplicate", async () => {
    await seedCampaign("camp-2", "New campaign");
    await prisma.lead.create({
      data: {
        email: "known@example.com",
        status: "ASSIGNED",
        sourceDetail: "Old campaign",
        source: "MAILCHIMP_CLICK",
      },
    });
    await seedActivity({
      email: "known@example.com",
      action: "click",
      campaignId: "camp-2",
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);

    expect(result.leadsCreated).toBe(0);
    expect(result.leadsUpdated).toBe(1);
    const leads = await prisma.lead.findMany({ where: { email: "known@example.com" } });
    expect(leads).toHaveLength(1); // not a duplicate
    expect(leads[0].lastActionAt).not.toBeNull();
  });

  it("collapses multiple activities for the same email, preferring click over open", async () => {
    await seedCampaign("camp-1");
    await seedActivity({
      email: "busy@example.com",
      action: "open",
      campaignId: "camp-1",
      timestamp: new Date("2026-04-22T09:00:00Z"),
    });
    await seedActivity({
      email: "busy@example.com",
      action: "open",
      campaignId: "camp-1",
      timestamp: new Date("2026-04-22T10:00:00Z"),
    });
    await seedActivity({
      email: "busy@example.com",
      action: "click",
      campaignId: "camp-1",
      timestamp: new Date("2026-04-22T11:00:00Z"),
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);
    expect(result.leadsCreated).toBe(1);
    const lead = await prisma.lead.findFirst({ where: { email: "busy@example.com" } });
    expect(lead?.source).toBe("MAILCHIMP_CLICK");
  });

  it("returns zero counts with empty activity", async () => {
    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);
    expect(result.leadsCreated).toBe(0);
    expect(result.leadsUpdated).toBe(0);
    expect(result.activitiesConsidered).toBe(0);
  });

  // ── Real-DB-only scenarios ──

  it("(REAL-DB) ignores bounce action — only open/click qualify", async () => {
    // The mock asserted the function passed `action: { in: ["open","click"] }`
    // to findMany. This asserts a real bounce row in the DB doesn't get
    // selected — covers enum-drift / typo bugs the mock can't catch.
    await seedCampaign("camp-1");
    await seedActivity({
      email: "bounced@example.com",
      action: "bounce",
      campaignId: "camp-1",
    });

    const result = await ingestNewMailchimpActivityAsLeads({}, prisma);
    expect(result.leadsCreated).toBe(0);
    expect(result.activitiesConsidered).toBe(0);
  });

  it("(REAL-DB) honors the campaignId filter when set", async () => {
    // Targeted-campaign ingestion path: only one campaign's activity
    // should land. Mock couldn't verify the SQL `where` actually
    // narrows.
    await seedCampaign("camp-A");
    await seedCampaign("camp-B");
    await seedActivity({
      email: "matters@example.com",
      action: "click",
      campaignId: "camp-A",
    });
    await seedActivity({
      email: "ignored@example.com",
      action: "click",
      campaignId: "camp-B",
    });

    const result = await ingestNewMailchimpActivityAsLeads({ campaignId: "camp-A" }, prisma);
    expect(result.leadsCreated).toBe(1);
    const leads = await prisma.lead.findMany();
    expect(leads.map((l) => l.email).sort()).toEqual(["matters@example.com"]);
  });
});

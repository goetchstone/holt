// /app/e2e/dynamicRoutes.ts
//
// How the browser smoke suite fills each dynamic route's parameters from the
// seeded database, or why it does not open that route. Static routes need no
// entry: pages.spec.ts opens every one. __tests__/e2eDynamicRoutes.test.ts
// fails when a dynamic route has no entry here, when an entry names a route
// that no longer exists, or when a skip has no reason (rule 65).
//
// `find` returns the URL to open (the route with its parameters filled), or
// null when the database holds no such row. In CI, where the seed is ours, null
// fails the run: a page the seed cannot reach is a page nobody has opened. Run
// by hand against some other database, it skips and says why.

import type { PrismaClient } from "@prisma/client";
import { generateClientPortalToken } from "../src/lib/clientPortalToken";
import { HELP_ARTICLES } from "../src/lib/help/catalog";
import { isModuleSettingsRoutable } from "../src/lib/modules";
import { MODULES } from "../src/lib/modules/registry";

export type DynamicRoute =
  { find: (db: PrismaClient) => Promise<string | null> } | { skip: string };

/** The URL for the first row `id` finds, or null when there is none. */
const byId =
  (path: string, row: (db: PrismaClient) => Promise<{ id: number } | null>) =>
  async (db: PrismaClient): Promise<string | null> => {
    const found = await row(db);
    return found ? path.replace("{}", String(found.id)) : null;
  };

/** Same, for a row keyed by a string (a token or slug). */
const byKey =
  (
    path: string,
    row: (db: PrismaClient) => Promise<Record<string, string | null> | null>,
    key: string,
  ) =>
  async (db: PrismaClient): Promise<string | null> => {
    const found = await row(db);
    return found?.[key] ? path.replace("{}", encodeURIComponent(found[key])) : null;
  };

const ORG = 1; // DEFAULT_ORG_ID (src/lib/appSettings.ts): one organization per deployment
const asc = { id: "asc" } as const;

export const DYNAMIC_ROUTES: Record<string, DynamicRoute> = {
  // The slug of a published, non-home CMS page (the home page is served at /).
  "/[...slug]": {
    find: byKey(
      "/{}",
      (db) =>
        db.page.findFirst({
          where: { organizationId: ORG, status: "PUBLISHED", isHome: false },
          orderBy: asc,
          select: { slug: true },
        }),
      "slug",
    ),
  },
  // BuyerDraftBuy.id, a buy with items to report on
  "/app/admin/buyer-drafts/buy/[id]/performance": {
    find: byId("/app/admin/buyer-drafts/buy/{}/performance", (db) =>
      db.buyerDraftBuy.findFirst({
        where: { pos: { some: { items: { some: {} } } } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // Page.id (CMS page)
  "/app/admin/cms/pages/[id]": {
    find: byId("/app/admin/cms/pages/{}", (db) =>
      db.page.findFirst({ where: { organizationId: ORG }, orderBy: asc, select: { id: true } }),
    ),
  },
  // Post.id (CMS blog post)
  "/app/admin/cms/posts/[id]": {
    find: byId("/app/admin/cms/posts/{}", (db) =>
      db.post.findFirst({ where: { organizationId: ORG }, orderBy: asc, select: { id: true } }),
    ),
  },
  // GiftCard.id
  "/app/admin/gift-cards/[id]": {
    find: byId("/app/admin/gift-cards/{}", (db) =>
      db.giftCard.findFirst({ where: { status: "ACTIVE" }, orderBy: asc, select: { id: true } }),
    ),
  },
  // A module key from the compile-time registry (src/lib/modules/registry.ts):
  // the first one this deployment would route, i.e. switched on and with settings
  // or a nav to render (isModuleSettingsRoutable, the page's own test). Only
  // dmarcTools qualifies today and it is off by default, so this finds one when
  // SMOKE_ALL_MODULES=1 has switched it on, as CI does.
  "/app/admin/settings/[module]": {
    find: async (db) => {
      const row = await db.appSettings.findFirst({
        where: { organizationId: ORG },
        select: { features: true },
      });
      const features = (row?.features ?? {}) as Record<string, boolean>;
      const key = MODULES.map((m) => m.key).find((k) => isModuleSettingsRoutable(features, k));
      return key ? `/app/admin/settings/${key}` : null;
    },
  },
  // PickList.id, one with items to pick
  "/app/dispatch/pick-list/[id]": {
    find: byId("/app/dispatch/pick-list/{}", (db) =>
      db.pickList.findFirst({ where: { items: { some: {} } }, orderBy: asc, select: { id: true } }),
    ),
  },
  // DeliveryRun.id, one with stops
  "/app/dispatch/run/[id]": {
    find: byId("/app/dispatch/run/{}", (db) =>
      db.deliveryRun.findFirst({
        where: { stops: { some: {} } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // A help article slug from the catalog (src/lib/help/catalog.ts); the markdown ships in help/
  "/app/help/[slug]": {
    find: async () => (HELP_ARTICLES[0] ? `/app/help/${HELP_ARTICLES[0].slug}` : null),
  },
  // Ticket.id (helpdesk)
  "/app/helpdesk/[id]": {
    find: byId("/app/helpdesk/{}", (db) =>
      db.ticket.findFirst({ where: { organizationId: ORG }, orderBy: asc, select: { id: true } }),
    ),
  },
  // CustomerInteraction.id
  "/app/interactions/[id]": {
    find: byId("/app/interactions/{}", (db) =>
      db.customerInteraction.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // ConsignmentItem.id
  "/app/inventory/consignment/[id]": {
    find: byId("/app/inventory/consignment/{}", (db) =>
      db.consignmentItem.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // Product.externalId (not Product.id): the previous system's stock id, which
  // the page looks the product up by. One with snapshots, so it has counts to show.
  "/app/inventory/product-variance/[externalId]": {
    find: async (db) => {
      const product = await db.product.findFirst({
        where: { externalId: { not: null }, inventorySnapshots: { some: {} } },
        orderBy: asc,
        select: { externalId: true },
      });
      return product?.externalId == null
        ? null
        : `/app/inventory/product-variance/${product.externalId}`;
    },
  },
  // Product.id
  "/app/inventory/products/[id]": {
    find: byId("/app/inventory/products/{}", (db) =>
      db.product.findFirst({ where: { isActive: true }, orderBy: asc, select: { id: true } }),
    ),
  },
  // PurchaseOrder.id, one with lines
  "/app/purchasing/orders/[id]": {
    find: byId("/app/purchasing/orders/{}", (db) =>
      db.purchaseOrder.findFirst({
        where: { lineItems: { some: {} } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  "/app/purchasing/orders/[id]/edit": {
    find: byId("/app/purchasing/orders/{}/edit", (db) =>
      db.purchaseOrder.findFirst({
        where: { lineItems: { some: {} } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // PurchaseOrder.id, one still open for receiving
  "/app/purchasing/orders/[id]/receive": {
    find: byId("/app/purchasing/orders/{}/receive", (db) =>
      db.purchaseOrder.findFirst({
        where: {
          status: { in: ["SUBMITTED", "CONFIRMED", "RECEIVED_PARTIAL"] },
          lineItems: { some: {} },
        },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // MailchimpCampaign.id (a string key from Mailchimp)
  "/app/reports/mailchimp/campaigns/[id]": {
    skip: "the demo seed writes no MailchimpCampaign rows: prisma/seed/coverage.ts classifies email campaign results as arriving from a sync, never seeded, and seeding invented campaigns instead waits on the owner's decision",
  },
  // Customer.id
  "/app/sales/customers/[id]": {
    find: byId("/app/sales/customers/{}", (db) =>
      db.customer.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // Invoice.id of an authored invoice with lines. The seeded order invoices
  // carry none, so the first invoice by id opened an empty page.
  "/app/sales/invoices/[id]": {
    find: byId("/app/sales/invoices/{}", (db) =>
      db.invoice.findFirst({
        where: { organizationId: ORG, lineItems: { some: {} } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // Invoice.id of an authored DRAFT (any other status 404s)
  "/app/sales/invoices/[id]/edit": {
    find: byId("/app/sales/invoices/{}/edit", (db) =>
      db.invoice.findFirst({
        where: { organizationId: ORG, status: "DRAFT" },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // SalesOrder.id, one with lines
  "/app/sales/orders/[id]": {
    find: byId("/app/sales/orders/{}", (db) =>
      db.salesOrder.findFirst({
        where: { lineItems: { some: {} } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // Proposal.id
  "/app/sales/proposals/[id]": {
    find: byId("/app/sales/proposals/{}", (db) =>
      db.proposal.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // Return.id
  "/app/sales/returns/[id]": {
    find: byId("/app/sales/returns/{}", (db) =>
      db.return.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // Till.id
  "/app/sales/till/[id]": {
    find: byId("/app/sales/till/{}", (db) =>
      db.till.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // ServiceCase.id
  "/app/service/cases/[id]": {
    find: byId("/app/service/cases/{}", (db) =>
      db.serviceCase.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // InventoryTransfer.id
  "/app/warehouse/transfers/[id]": {
    find: byId("/app/warehouse/transfers/{}", (db) =>
      db.inventoryTransfer.findFirst({ orderBy: asc, select: { id: true } }),
    ),
  },
  // Post.slug of a published post
  "/blog/[slug]": {
    find: byKey(
      "/blog/{}",
      (db) =>
        db.post.findFirst({
          where: { organizationId: ORG, status: "PUBLISHED" },
          orderBy: asc,
          select: { slug: true },
        }),
      "slug",
    ),
  },
  // A client-portal token for a customer with tickets, so the portal has
  // something to list. The token is a stateless JWT keyed from NEXTAUTH_SECRET
  // (lib/capabilityToken.ts), not a row. It is minted with the production helper
  // and this process's secret, which must be the running app's: CI's smoke job
  // sets one for both. Run by hand without it, the route skips; with a different
  // secret, it fails on the page's 404, because the app really verifies it.
  "/portal/client/[token]": {
    find: async (db) => {
      if (!process.env.NEXTAUTH_SECRET) return null;
      const customer = await db.customer.findFirst({
        where: { tickets: { some: { organizationId: ORG } } },
        orderBy: asc,
        select: { id: true },
      });
      return customer ? `/portal/client/${generateClientPortalToken(customer.id)}` : null;
    },
  },
  // Return.portalToken of a return still INITIATED, the request page's own case
  // (once it has moved on, the page only says it was submitted)
  "/portal/return/[token]": {
    find: byKey(
      "/portal/return/{}",
      (db) =>
        db.return.findFirst({
          where: { portalToken: { not: null }, status: "INITIATED" },
          orderBy: asc,
          select: { portalToken: true },
        }),
      "portalToken",
    ),
  },
  // Return.portalToken
  "/portal/return/status/[token]": {
    find: byKey(
      "/portal/return/status/{}",
      (db) =>
        db.return.findFirst({
          where: { portalToken: { not: null } },
          orderBy: asc,
          select: { portalToken: true },
        }),
      "portalToken",
    ),
  },
  // SalesOrder.id (the print view reads /api/print/order/[id])
  "/print/invoice/[id]": {
    find: byId("/print/invoice/{}", (db) =>
      db.salesOrder.findFirst({
        where: { lineItems: { some: {} } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  "/print/receipt/[id]": {
    find: byId("/print/receipt/{}", (db) =>
      db.salesOrder.findFirst({
        where: { lineItems: { some: {} } },
        orderBy: asc,
        select: { id: true },
      }),
    ),
  },
  // Ticket.publicToken
  "/support/[token]": {
    find: byKey(
      "/support/{}",
      (db) =>
        db.ticket.findFirst({
          where: { organizationId: ORG },
          orderBy: asc,
          select: { publicToken: true },
        }),
      "publicToken",
    ),
  },
};

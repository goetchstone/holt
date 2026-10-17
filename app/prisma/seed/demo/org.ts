// app/prisma/seed/demo/org.ts
//
// Organization + AppSettings — branding, currency/timezone, and the
// feature flags a running store would actually have turned on.

import type { PrismaClient } from "@prisma/client";
import { assertKnownModules } from "@/lib/modules/registry";
import { SEED_TIME_ZONE } from "./config";

const SEED_ACTOR = "seed:demo";

export const ORG_SLUG = "holt-home-rug-co";

export interface OrgSetup {
  organizationId: number;
}

export async function seedOrg(prisma: PrismaClient): Promise<OrgSetup> {
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: { name: "Holt Home & Rug Co." },
    create: {
      name: "Holt Home & Rug Co.",
      slug: ORG_SLUG,
      createdBy: SEED_ACTOR,
    },
  });

  await prisma.appSettings.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      appName: "Holt Home & Rug Co.",
      companyName: "Holt Home & Rug Co.",
      // The store talking to its customers: it prints under the name on every
      // receipt and invoice (app/print/*) and heads the storefront. It read
      // "... two showrooms, one ledger" -- a line about Holt, not the store,
      // which no customer should find on their receipt.
      tagline: "Furniture and rugs for considered homes.",
      // The store's own returns note, printed at the foot of receipts and
      // invoices (AppSettings.receiptFooter). A furniture store's usual terms:
      // stock pieces come back, made-to-order ones do not.
      receiptFooter:
        "Returns within 30 days with receipt. Special and custom orders are final sale.",
      supportEmail: "support@example.com",
      currency: "USD",
      locale: "en-US",
      timezone: SEED_TIME_ZONE,
      // "Ink and clay": warm near-black and oatmeal, with clay as the only hue.
      // Chosen 2026-10-17 to read as restrained and premium in a demo -- one
      // confident accent on warm neutrals, the pattern Square, Lightspeed and
      // Linear use, with the clay and oatmeal carrying the furniture-showroom
      // warmth. WCAG contrast on the page, computed: text 15.9:1, primary
      // 14.9:1, muted text 5.5:1, clay 4.9:1, secondary blue 5.2:1; white on
      // the primary 16.0:1 and on clay 5.3:1 -- all past AA's 4.5:1.
      //
      // Still deliberately unlike the built-in default (navy / linen / gold),
      // which real deployments start from, so anyone with several Holt
      // instances open can tell the demo apart at a glance. It replaces a deep
      // teal with a burnt-orange accent on a cool off-white.
      //
      // Slots are the AppSettings.theme keys (lib/appSettings.ts DEFAULT_THEME):
      // navy = primary and sidebar, linen = page, gold = accent, gray = muted
      // text and rules, black = text, stripe = muted surface, brandGray =
      // borders and inputs, brandBlue = the secondary, informational hue.
      theme: {
        navy: "#24211D",
        linen: "#F8F6F2",
        gold: "#A9532F",
        gray: "#67635B",
        black: "#1D1B18",
        stripe: "#EFECE6",
        brandGray: "#BFB8AC",
        brandBlue: "#4F6B86",
      },
      // Sensible defaults for a store that runs its whole operation on
      // the platform -- this is the "full native chain" seed, so every
      // module the seed touches is switched on.
      // Every key MUST exist in lib/modules/registry.ts. Four of the seven that
      // used to be here -- commission, storefront, invoicing, deliveryScheduling
      // -- were not module keys at all and were silently discarded, which left
      // seventeen real modules at their registry defaults. That is why Invoices
      // 404'd and half the nav was missing on a fresh clone.
      // assertKnownModules() makes a typo fail loudly instead.
      features: assertKnownModules({
        warehousing: true,
        dispatch: true,
        consignment: true,
        purchasing: true,
        pos: true,
        giftCards: true,
        tills: true,
        accounting: true,
        marketing: true,
        cms: true,
        blog: true,
        booking: true,
        helpdesk: true,
        timeTracking: true,
        billing: true,
        clientPortal: true,
        // Showroom-floor conventions, default OFF because most businesses have
        // neither a rotation nor a door counter. This demo is a showroom.
        upBoard: true,
        storeTraffic: true,
      }),
      bookingConfig: {
        windowDays: 21,
        startHour: 9,
        endHour: 17,
        slotMinutes: 60,
      },
      createdBy: SEED_ACTOR,
    },
  });

  return { organizationId: org.id };
}

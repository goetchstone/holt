// app/prisma/seed/demo/org.ts
//
// Organization + AppSettings — branding, currency/timezone, and the
// feature flags a running store would actually have turned on.

import type { PrismaClient } from "@prisma/client";
import { assertKnownModules } from "@/lib/modules/registry";

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
      tagline: "Furniture and rugs for considered homes — two showrooms, one ledger.",
      supportEmail: "support@example.com",
      currency: "USD",
      locale: "en-US",
      timezone: "America/New_York",
      // Deliberately unlike any real deployment's palette: deep teal with a
      // burnt-orange accent on a cool off-white, so anyone with several Holt
      // instances open can tell the demo apart at a glance. (It used to be a
      // navy / linen / gold close to the built-in default, which real
      // deployments also start from.)
      theme: {
        navy: "#134E4A",
        linen: "#F3F7F6",
        gold: "#C2410C",
        gray: "#56635F",
        black: "#0F1A18",
        stripe: "#E8F0EE",
        brandGray: "#9DB0AB",
        brandBlue: "#2C7A72",
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

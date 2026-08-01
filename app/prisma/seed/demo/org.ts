// app/prisma/seed/demo/org.ts
//
// Organization + AppSettings — branding, currency/timezone, and the
// feature flags a running store would actually have turned on.

import type { PrismaClient } from "@prisma/client";

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
      tagline: "Furniture and rugs for considered homes — three showrooms, one ledger.",
      supportEmail: "support@example.com",
      currency: "USD",
      locale: "en-US",
      timezone: "America/New_York",
      theme: {
        navy: "#1F2A44",
        linen: "#F5F1EA",
        gold: "#B98A3E",
        gray: "#6B6B6B",
        black: "#1A1A1A",
        brandGray: "#8C8C86",
        brandBlue: "#2E4A6B",
      },
      // Sensible defaults for a store that runs its whole operation on
      // the platform -- this is the "full native chain" seed, so every
      // module the seed touches is switched on.
      features: {
        warehousing: true,
        dispatch: true,
        consignment: true,
        commission: true,
        storefront: true,
        invoicing: true,
        deliveryScheduling: true,
      },
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

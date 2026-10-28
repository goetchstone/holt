// /app/src/lib/gettingStartedServer.ts
//
// Server-side loader for the getting-started checklist. It only fetches: every
// decision about what counts as done lives in the pure gettingStarted.ts
// (CLAUDE.md rule 14). Counts and a capped name list, so the reads stay
// bounded however many stores, vendors or staff a deployment has.

import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { getActiveProvider } from "@/lib/payments";
import {
  buildGettingStarted,
  type GettingStartedFacts,
  type GettingStartedItem,
} from "@/lib/gettingStarted";

/** Store names shown in the tax item's detail line before "and N more". */
const STORE_NAMES_SHOWN = 3;

export async function loadGettingStartedFacts(): Promise<GettingStartedFacts> {
  const settings = await getAppSettings();
  const provider = getActiveProvider();
  const storeWithoutDistrict = { isActive: true, taxDistrictId: null };

  const [
    activeStoreCount,
    storesWithoutTaxDistrictCount,
    storesWithoutTaxDistrictNames,
    activeTaxDistrictCount,
    vendorsWithMarkupCount,
    activeStaffCount,
    providerConfigured,
  ] = await Promise.all([
    prisma.storeLocation.count({ where: { isActive: true } }),
    prisma.storeLocation.count({ where: storeWithoutDistrict }),
    prisma.storeLocation.findMany({
      where: storeWithoutDistrict,
      select: { name: true },
      orderBy: { sortOrder: "asc" },
      take: STORE_NAMES_SHOWN,
    }),
    prisma.taxDistrict.count({ where: { isActive: true } }),
    // gt excludes NULL, and a zero or negative markup is not honoured by the
    // catalog either (pricing/products.ts resolveVendorMarkup), so it does not
    // count as set.
    prisma.vendor.count({ where: { defaultMarkup: { gt: 0 } } }),
    prisma.staffMember.count({ where: { isActive: true } }),
    provider.isConfigured(),
  ]);

  return {
    activeStoreCount,
    storesWithoutTaxDistrict: {
      count: storesWithoutTaxDistrictCount,
      names: storesWithoutTaxDistrictNames.map((s) => s.name),
    },
    activeTaxDistrictCount,
    defaultTaxDistrictId: settings.defaultTaxDistrictId,
    setupConfirmedAt: settings.setupConfirmedAt,
    vendorsWithMarkupCount,
    storeWideDefaultMarkup: settings.pricing.defaultMarkup,
    activeStaffCount,
    paymentProvider: { name: provider.displayName, configured: providerConfigured },
    cashOnlyAcknowledgedAt: settings.cashOnlyAcknowledgedAt,
  };
}

export async function loadGettingStarted(): Promise<GettingStartedItem[]> {
  return buildGettingStarted(await loadGettingStartedFacts());
}

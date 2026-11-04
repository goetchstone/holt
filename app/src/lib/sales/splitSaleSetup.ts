// /app/src/lib/sales/splitSaleSetup.ts
//
// GAP-07: what the register and the quote builder offer someone allowed to
// split a sale ("Reassign salesperson"): the colleagues still working here,
// leaving out the seller, and the store's default share. Built in the page on
// the server, so offering a split reads no staff list over the API (that one
// is "Manage staff"). create-from-cart checks the same things again on save.

import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import type { SplitSaleSetup } from "@/lib/commissionSplit";

export async function splitSaleSetup(
  sellerUserId: string,
  allowed: boolean,
): Promise<SplitSaleSetup | null> {
  if (!allowed) return null;
  const [staff, settings] = await Promise.all([
    prisma.staffMember.findMany({
      where: { isActive: true, OR: [{ userId: null }, { userId: { not: sellerUserId } }] },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true },
    }),
    getAppSettings(),
  ]);
  return {
    partners: staff.map((s) => ({ id: s.id, name: s.displayName })),
    defaultPercent: settings.defaultSplitPercent,
  };
}

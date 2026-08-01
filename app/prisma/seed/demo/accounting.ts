// app/prisma/seed/demo/accounting.ts
//
// Chart of accounts + AccountGroup mapping + SystemGLMapping + tax setup.
//
// This is the part of the seed the spec calls out as make-or-break:
// `generateSalesJournal()` (lib/journalEntry.ts) SKIPS any payment type
// or account-group leg that isn't mapped, with only a `warnings[]` push --
// the journal still comes back "balanced" (the Over/Short line silently
// absorbs the gap once one exists) but is materially short. So every
// payment method AND every department's sales/COGS/inventory legs get a
// real GL account here; there is no path left for `generateSalesJournal`
// to fall back to a warning instead of a real line.
//
// GL codes and account roles follow docs/domains/accounting.md's
// documented chart exactly (1-1006 Cash, 1-1200/1-1203 deposits, 1-13XX
// inventory by department, 2-2120 tax payable, 2-2127 gift-card liability,
// 4-40XX sales by department, 4-0005 Over/Short, 5-52XX COGS by
// department). Store Credit (2-2128) and the per-department shrinkage
// account (shared 5-5010) aren't in that doc's worked example but follow
// the same numbering convention -- the doc's sample simply predates a day
// with a store-credit redemption or a classified write-off.
//
// Reference values (CT district, 6.35%, 3 exempt reasons, "Standard
// Retail" tax group) intentionally match prisma/seed/tax.ts's seed data --
// tax.ts's own PrismaClient() construction predates Prisma 7's driver-
// adapter requirement and currently throws on `new PrismaClient()` with no
// adapter (verified while building this seed; see docs/domains/seed-data.md
// "What fought me"), so this module seeds the same rows directly through
// this seed's adapter-backed client rather than importing a broken script.

import type { PrismaClient } from "@prisma/client";
import { DEPARTMENTS } from "./catalogTaxonomy";

const SEED_ACTOR = "seed:demo";

export interface AccountingSetup {
  accountGroupIdByDepartment: Map<string, number>;
  taxDistrictId: number;
  standardRetailTaxGroupId: number;
  taxExemptReasonIdByName: Map<string, number>;
  glAccountIdByCode: Map<string, number>;
}

export async function seedAccounting(prisma: PrismaClient): Promise<AccountingSetup> {
  const glAccountIdByCode = new Map<string, number>();

  async function upsertGl(code: string, name: string, accountType: string): Promise<number> {
    const row = await prisma.gLAccount.upsert({
      where: { code },
      update: { name, accountType },
      create: { code, name, accountType, createdBy: SEED_ACTOR },
    });
    glAccountIdByCode.set(code, row.id);
    return row.id;
  }

  // --- Static (non-department) accounts ------------------------------
  await upsertGl("1-1006", "Cash / Combined Receipts", "ASSET");
  await upsertGl("1-1200", "Pmt On Acct (Customer Deposits)", "ASSET");
  await upsertGl("1-1203", "Pmt On Acct (Layaway)", "ASSET");
  await upsertGl("2-2120", "CT Sales Tax Payable", "LIABILITY");
  await upsertGl("2-2127", "Gift Card Liability", "LIABILITY");
  await upsertGl("2-2128", "Store Credit Liability", "LIABILITY");
  await upsertGl("4-0005", "Over/Short", "REVENUE");
  await upsertGl("5-5005", "Transfers (Between Stores)", "EXPENSE");
  await upsertGl("5-5010", "Shrinkage / Write-offs", "EXPENSE");
  await upsertGl("5-5300", "Purchase Invoice Accrual / Freight", "LIABILITY");

  // --- Per-department inventory / sales / COGS ------------------------
  const accountGroupIdByDepartment = new Map<string, number>();
  for (const dept of DEPARTMENTS) {
    const inventoryId = await upsertGl(`1-13${dept.glSuffix}`, `Inventory: ${dept.name}`, "ASSET");
    const salesId = await upsertGl(`4-40${dept.glSuffix}`, `Sales: ${dept.name}`, "REVENUE");
    const cogsId = await upsertGl(`5-52${dept.glSuffix}`, `COGS: ${dept.name}`, "EXPENSE");

    const group = await prisma.accountGroup.upsert({
      where: { name: dept.name },
      update: {
        inventoryAccountId: inventoryId,
        salesAccountId: salesId,
        cogsAccountId: cogsId,
        shrinkageAccountId: glAccountIdByCode.get("5-5010"),
        transfersAccountId: glAccountIdByCode.get("5-5005"),
      },
      create: {
        name: dept.name,
        description: `${dept.name} — sales, cost of goods sold, and on-hand inventory`,
        inventoryAccountId: inventoryId,
        salesAccountId: salesId,
        cogsAccountId: cogsId,
        shrinkageAccountId: glAccountIdByCode.get("5-5010"),
        transfersAccountId: glAccountIdByCode.get("5-5005"),
        createdBy: SEED_ACTOR,
      },
    });
    accountGroupIdByDepartment.set(dept.name, group.id);
  }

  // --- SystemGLMapping: POS_PAYMENTS ----------------------------------
  // Every METHOD_DISPLAY value (lib/paymentMethodDisplay.ts) gets a
  // lowercase-matched label here -- generateSalesJournal() keys its
  // paymentGlMap off `payment.paymentType.toLowerCase()`.
  async function upsertMapping(section: string, label: string, code: string): Promise<void> {
    const glAccountId = glAccountIdByCode.get(code);
    if (!glAccountId) throw new Error(`seedAccounting: no GL account for code ${code}`);
    await prisma.systemGLMapping.upsert({
      where: { section_label: { section, label } },
      update: { glAccountId },
      create: { section, label, glAccountId, createdBy: SEED_ACTOR },
    });
  }

  // Cash-like tenders share the combined-receipts account, matching the
  // business's real Cash / Amex / Visa / MC / Discover / Debit / Check
  // convention (docs/domains/accounting.md) -- each gets its own journal
  // line for memo clarity but posts to the same GL.
  await upsertMapping("POS_PAYMENTS", "Cash", "1-1006");
  await upsertMapping("POS_PAYMENTS", "Card", "1-1006");
  await upsertMapping("POS_PAYMENTS", "Check", "1-1006");
  await upsertMapping("POS_PAYMENTS", "Wire", "1-1006");
  await upsertMapping("POS_PAYMENTS", "ACH", "1-1006");
  await upsertMapping("POS_PAYMENTS", "Finance", "1-1006");
  await upsertMapping("POS_PAYMENTS", "Other", "1-1006");
  // Redeeming a gift card / store credit isn't new cash -- it retires a
  // liability recorded when the card was sold / the credit was issued.
  // "Gift Card" -> 2-2127 hits journalEntry.ts's hardcoded
  // LIABILITY_DEBIT_CODES special case; Store Credit gets its own liability
  // account so it isn't misreported as a cash receipt.
  await upsertMapping("POS_PAYMENTS", "Gift Card", "2-2127");
  await upsertMapping("POS_PAYMENTS", "Store Credit", "2-2128");
  // Deposit resolution (lib/journalEntry.ts: `paymentGlMap.get("on account")
  // || paymentGlMap.get("deposit")`) also reads from the POS_PAYMENTS
  // section -- this is what makes an un-invoiced order's payment book as
  // "Pmt On Acct" instead of falling through unmapped.
  await upsertMapping("POS_PAYMENTS", "On Account", "1-1200");

  // --- SystemGLMapping: POS_TRANSACTIONS ------------------------------
  await upsertMapping("POS_TRANSACTIONS", "Sales Tax", "2-2120");
  await upsertMapping("POS_TRANSACTIONS", "Over/Short", "4-0005");

  // --- Tax setup (CT district, Standard Retail 6.35%, 3 exempt reasons) --
  const ct = await prisma.taxDistrict.upsert({
    where: { shortName: "CT" },
    update: { glAccountId: glAccountIdByCode.get("2-2120") },
    create: {
      shortName: "CT",
      state: "CT",
      name: "Connecticut State Sales Tax",
      glAccountId: glAccountIdByCode.get("2-2120"),
      createdBy: SEED_ACTOR,
    },
  });

  const taxExemptReasonIdByName = new Map<string, number>();
  for (const name of ["Resale", "Out of State", "Non-Profit"]) {
    const row = await prisma.taxExemptReason.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    taxExemptReasonIdByName.set(name, row.id);
  }

  const standardRetail = await prisma.taxGroup.upsert({
    where: { name: "Standard Retail" },
    update: {},
    create: {
      name: "Standard Retail",
      taxBasis: "NET",
      freightTaxable: false,
      miscTaxable: false,
    },
  });

  await prisma.taxRule.upsert({
    where: {
      districtId_groupId_sortOrder: { districtId: ct.id, groupId: standardRetail.id, sortOrder: 0 },
    },
    update: { taxRate: 0.0635 },
    create: { districtId: ct.id, groupId: standardRetail.id, taxRate: 0.0635, sortOrder: 0 },
  });

  return {
    accountGroupIdByDepartment,
    taxDistrictId: ct.id,
    standardRetailTaxGroupId: standardRetail.id,
    taxExemptReasonIdByName,
    glAccountIdByCode,
  };
}

// /app/src/lib/genericImportRunner.ts
//
// Server-side execution of the generic CSV importer. Takes a chosen entity, a
// field->header mapping, and the parsed CSV rows, and upserts records using
// the same dedup/creation conventions as the rest of the app. Coercion and
// validation happen here at the trust boundary; callers pass raw row objects
// straight through.

import { prisma } from "@/lib/prisma";
import { findOrCreateCustomer, safeString, safeFloat } from "@/lib/importHelpers";
import { getImportEntity, type ColumnMapping, type GenericImportResult } from "@/lib/genericImport";
import { logError } from "@/lib/logger";

type RawRow = Record<string, unknown>;

function pickString(row: RawRow, mapping: ColumnMapping, field: string): string | undefined {
  const header = mapping[field];
  if (!header) return undefined;
  return safeString(row[header]);
}

function pickNumber(row: RawRow, mapping: ColumnMapping, field: string): number | undefined {
  const raw = pickString(row, mapping, field);
  return raw === undefined ? undefined : safeFloat(raw);
}

function rowError(result: GenericImportResult, index: number, err: unknown, context: string): void {
  logError(`Generic import (${context}) row ${index + 1}`, err);
  result.errors.push(`Row ${index + 1}: ${err instanceof Error ? err.message : "import failed"}`);
  result.skipped++;
}

export async function runGenericImport(
  entityKey: string,
  mapping: ColumnMapping,
  rows: RawRow[],
  userEmail: string,
): Promise<GenericImportResult> {
  if (!getImportEntity(entityKey)) {
    return { imported: 0, skipped: 0, errors: [`Unknown import type: ${entityKey}`] };
  }
  if (entityKey === "customer") return importCustomers(mapping, rows, userEmail);
  if (entityKey === "product") return importProducts(mapping, rows, userEmail);
  return { imported: 0, skipped: 0, errors: [`Import for "${entityKey}" is not implemented yet.`] };
}

async function importCustomers(
  mapping: ColumnMapping,
  rows: RawRow[],
  userEmail: string,
): Promise<GenericImportResult> {
  const result: GenericImportResult = { imported: 0, skipped: 0, errors: [] };

  // Sequential, not parallel: findOrCreateCustomer dedups against rows created
  // earlier in the same import, so concurrent processing would race and create
  // duplicates.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const externalId = pickString(row, mapping, "externalId");
      const fullName = pickString(row, mapping, "name");
      const firstName = pickString(row, mapping, "firstName");
      const lastName = pickString(row, mapping, "lastName");
      const composed = [firstName, lastName].filter(Boolean).join(" ").trim();
      const customerName = fullName ?? (composed || undefined);
      const email = pickString(row, mapping, "email")?.toLowerCase();
      const phone = pickString(row, mapping, "phone");

      if (!customerName && !externalId) {
        result.skipped++;
        continue;
      }

      const customer = await findOrCreateCustomer(prisma, {
        cuscode: externalId,
        customerName,
        email,
        phone,
        createdBy: userEmail,
      });
      if (!customer) {
        result.skipped++;
        continue;
      }

      const address1 = pickString(row, mapping, "address1");
      if (address1) {
        const existing = await prisma.customerAddress.findFirst({
          where: { customerId: customer.id, address1 },
          select: { id: true },
        });
        if (!existing) {
          await prisma.customerAddress.create({
            data: {
              customerId: customer.id,
              address1,
              city: pickString(row, mapping, "city") ?? "",
              state: pickString(row, mapping, "state") ?? "",
              zip: pickString(row, mapping, "zip") ?? "",
              createdBy: userEmail,
            },
          });
        }
      }
      result.imported++;
    } catch (err) {
      rowError(result, i, err, "customer");
    }
  }

  return result;
}

async function importProducts(
  mapping: ColumnMapping,
  rows: RawRow[],
  userEmail: string,
): Promise<GenericImportResult> {
  const result: GenericImportResult = { imported: 0, skipped: 0, errors: [] };

  // Cache name->id resolutions so a catalog with one vendor doesn't issue a
  // lookup per row.
  const vendorCache = new Map<string, number>();
  const departmentCache = new Map<string, number>();
  const categoryCache = new Map<string, number>();

  const resolveVendor = async (name: string): Promise<number> => {
    const key = name.toLowerCase();
    const cached = vendorCache.get(key);
    if (cached) return cached;
    const existing = await prisma.vendor.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    const id =
      existing?.id ??
      (await prisma.vendor.create({ data: { name, createdBy: userEmail }, select: { id: true } }))
        .id;
    vendorCache.set(key, id);
    return id;
  };

  const resolveDepartment = async (name: string): Promise<number> => {
    const key = name.toLowerCase();
    const cached = departmentCache.get(key);
    if (cached) return cached;
    const existing = await prisma.department.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    const id =
      existing?.id ??
      (
        await prisma.department.create({
          data: { name, createdBy: userEmail },
          select: { id: true },
        })
      ).id;
    departmentCache.set(key, id);
    return id;
  };

  const resolveCategory = async (name: string, departmentId: number): Promise<number> => {
    const key = `${departmentId}:${name.toLowerCase()}`;
    const cached = categoryCache.get(key);
    if (cached) return cached;
    const existing = await prisma.category.findFirst({
      where: { departmentId, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    const id =
      existing?.id ??
      (
        await prisma.category.create({
          data: { name, departmentId, createdBy: userEmail },
          select: { id: true },
        })
      ).id;
    categoryCache.set(key, id);
    return id;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const productNumber = pickString(row, mapping, "productNumber");
      const name = pickString(row, mapping, "name");
      if (!productNumber || !name) {
        result.skipped++;
        continue;
      }

      const vendorId = await resolveVendor(pickString(row, mapping, "vendor") ?? "Unknown Vendor");
      const departmentId = await resolveDepartment(
        pickString(row, mapping, "department") ?? "Uncategorized",
      );
      const categoryId = await resolveCategory(
        pickString(row, mapping, "category") ?? "Uncategorized",
        departmentId,
      );

      const baseCost = pickNumber(row, mapping, "baseCost");
      const baseRetail = pickNumber(row, mapping, "baseRetail");
      const description = pickString(row, mapping, "description");

      const existing = await prisma.product.findFirst({
        where: { productNumber, vendorId },
        select: { id: true },
      });
      if (existing) {
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            name,
            departmentId,
            categoryId,
            description,
            baseCost,
            baseRetail,
            updatedBy: userEmail,
          },
        });
      } else {
        await prisma.product.create({
          data: {
            productNumber,
            name,
            vendorId,
            departmentId,
            categoryId,
            description,
            baseCost,
            baseRetail,
            createdBy: userEmail,
          },
        });
      }
      result.imported++;
    } catch (err) {
      rowError(result, i, err, "product");
    }
  }

  return result;
}

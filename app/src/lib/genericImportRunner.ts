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

/**
 * The ONE writer for categories. Shared by `pages/api/categories/import.ts` and
 * the `category` runner (rules 6/7).
 *
 * The department is created when missing. A category cannot be filed without
 * one, and departments are a short flat list an operator recognises at a glance
 * -- so inventing one from a typo is visible rather than buried. Contrast
 * importTypes below, which refuses to do the same thing for a reason.
 *
 * An existing category is UPDATED rather than left alone: unlike a department
 * name, the account-group link is the kind of thing a re-import is meant to fix.
 */
async function importCategories(
  mapping: ColumnMapping,
  rows: RawRow[],
  _userEmail: string,
): Promise<GenericImportResult> {
  const result: GenericImportResult = { imported: 0, skipped: 0, errors: [] };
  const nameColumn = mapping.name;
  const deptColumn = mapping.department;
  if (!nameColumn) {
    result.errors.push("No source column is mapped to Category Name.");
    return result;
  }
  if (!deptColumn) {
    result.errors.push("No source column is mapped to Department.");
    return result;
  }

  for (const [index, row] of rows.entries()) {
    const name = String(row[nameColumn] ?? "").trim();
    const departmentName = String(row[deptColumn] ?? "").trim();
    if (!name) {
      result.skipped++;
      continue;
    }
    if (!departmentName) {
      result.errors.push(`Row ${index + 1} ("${name}"): no department given.`);
      continue;
    }
    try {
      const department = await prisma.department.upsert({
        where: { name: departmentName },
        update: {},
        create: { name: departmentName },
      });

      let accountGroupId: number | undefined;
      const groupColumn = mapping.accountGroup;
      const groupName = groupColumn ? String(row[groupColumn] ?? "").trim() : "";
      if (groupName) {
        const group = await prisma.accountGroup.upsert({
          where: { name: groupName },
          update: {},
          create: { name: groupName },
        });
        accountGroupId = group.id;
      }

      // Scoped by department: two departments may each have a "Chairs".
      const existing = await prisma.category.findFirst({
        where: { name, departmentId: department.id },
        select: { id: true },
      });
      if (existing) {
        await prisma.category.update({
          where: { id: existing.id },
          data: accountGroupId === undefined ? {} : { accountGroupId },
        });
      } else {
        await prisma.category.create({
          data: { name, departmentId: department.id, accountGroupId },
        });
      }
      result.imported++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Row ${index + 1} ("${name}"): ${message}`);
    }
  }
  return result;
}

/**
 * The ONE writer for types. Shared by `pages/api/types/import.ts` and the `type`
 * runner (rules 6/7).
 *
 * An unknown category is an ERROR, not a prompt to create one. Types are the
 * most numerous level of the taxonomy, so a mistyped category name would
 * silently create a near-duplicate and split a catalog in two -- with the
 * products landing in whichever half they were imported against. Reporting the
 * row is recoverable; a split taxonomy discovered months later is not.
 */
async function importTypes(
  mapping: ColumnMapping,
  rows: RawRow[],
  _userEmail: string,
): Promise<GenericImportResult> {
  const result: GenericImportResult = { imported: 0, skipped: 0, errors: [] };
  const nameColumn = mapping.name;
  const categoryColumn = mapping.category;
  if (!nameColumn) {
    result.errors.push("No source column is mapped to Type Name.");
    return result;
  }
  if (!categoryColumn) {
    result.errors.push("No source column is mapped to Category.");
    return result;
  }

  for (const [index, row] of rows.entries()) {
    const name = String(row[nameColumn] ?? "").trim();
    const categoryName = String(row[categoryColumn] ?? "").trim();
    if (!name) {
      result.skipped++;
      continue;
    }
    try {
      const category = await prisma.category.findFirst({
        where: { name: categoryName },
        select: { id: true },
      });
      if (!category) {
        result.errors.push(
          `Row ${index + 1} ("${name}"): no category named "${categoryName}". Import categories first.`,
        );
        continue;
      }
      const existing = await prisma.type.findFirst({
        where: { name, categoryId: category.id },
        select: { id: true },
      });
      if (!existing) {
        await prisma.type.create({ data: { name, categoryId: category.id } });
      }
      result.imported++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Row ${index + 1} ("${name}"): ${message}`);
    }
  }
  return result;
}

/**
 * The ONE writer for vendors. `pages/api/vendors/import.ts` (the fixed-shape
 * REST route) and the `vendor` runner both call this -- two import doors, one
 * implementation, so they cannot disagree (rules 6/7).
 *
 * `update` fills only what the file actually carried: a vendor that already
 * exists keeps every field the incoming row left blank. Re-importing a partial
 * list must not blank out terms and account numbers somebody has since filled
 * in, which a naive upsert would do.
 *
 * A `code` already held by a DIFFERENT vendor is reported rather than moved.
 * The column is unique, so silently reassigning it would detach part numbers
 * from the vendor they belong to.
 */
async function importVendors(
  mapping: ColumnMapping,
  rows: RawRow[],
  _userEmail: string,
): Promise<GenericImportResult> {
  const result: GenericImportResult = { imported: 0, skipped: 0, errors: [] };
  const nameColumn = mapping.name;
  if (!nameColumn) {
    result.errors.push("No source column is mapped to Vendor Name.");
    return result;
  }

  const text = (row: RawRow, key: string): string | undefined => {
    const column = mapping[key];
    if (!column) return undefined;
    const value = String(row[column] ?? "").trim();
    return value === "" ? undefined : value;
  };

  for (const [index, row] of rows.entries()) {
    const name = String(row[nameColumn] ?? "").trim();
    if (!name) {
      // A blank name is a trailing CSV line far more often than an error.
      result.skipped++;
      continue;
    }
    const code = text(row, "code");
    try {
      if (code) {
        const clash = await prisma.vendor.findFirst({
          where: { code, NOT: { name } },
          select: { name: true },
        });
        if (clash) {
          result.errors.push(
            `Row ${index + 1} ("${name}"): vendor code "${code}" already belongs to "${clash.name}".`,
          );
          continue;
        }
      }
      const optional = {
        code,
        accountNumber: text(row, "accountNumber"),
        paymentTerms: text(row, "paymentTerms"),
        website: text(row, "website"),
        phone: text(row, "phone"),
        email: text(row, "email"),
        address: text(row, "address"),
        city: text(row, "city"),
        state: text(row, "state"),
        zip: text(row, "zip"),
      };
      // Only the keys this row actually supplied, so blanks do not overwrite.
      const update = Object.fromEntries(
        Object.entries(optional).filter(([, v]) => v !== undefined),
      );
      await prisma.vendor.upsert({
        where: { name },
        update,
        create: { name, ...update },
      });
      result.imported++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Row ${index + 1} ("${name}"): ${message}`);
    }
  }
  return result;
}

/**
 * Departments: upsert by name, which is the model's own unique key.
 *
 * The ONE writer for departments. `pages/api/departments/import.ts` (the
 * fixed-shape REST route the admin Import page posts to) and the `department`
 * runner in lib/imports/runnerRegistry.ts (the configurable path, where an
 * operator maps whatever their file calls the column) both call this. Two
 * import doors, one implementation -- rule 6/7's "don't invent a second source
 * of truth that can disagree with the first."
 *
 * `update: {}` on purpose: a department that already exists is left exactly as
 * it is. Re-importing a taxonomy must not silently rewrite names an operator
 * has since corrected in-app.
 */
async function importDepartments(
  mapping: ColumnMapping,
  rows: RawRow[],
  _userEmail: string,
): Promise<GenericImportResult> {
  const result: GenericImportResult = { imported: 0, skipped: 0, errors: [] };
  const nameColumn = mapping.name;
  if (!nameColumn) {
    result.errors.push("No source column is mapped to Department Name.");
    return result;
  }

  for (const [index, row] of rows.entries()) {
    const name = String(row[nameColumn] ?? "").trim();
    if (!name) {
      // A blank name is a trailing CSV line far more often than an error.
      result.skipped++;
      continue;
    }
    try {
      await prisma.department.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      result.imported++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Row ${index + 1} ("${name}"): ${message}`);
    }
  }
  return result;
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
  if (entityKey === "department") return importDepartments(mapping, rows, userEmail);
  if (entityKey === "vendor") return importVendors(mapping, rows, userEmail);
  if (entityKey === "category") return importCategories(mapping, rows, userEmail);
  if (entityKey === "type") return importTypes(mapping, rows, userEmail);
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

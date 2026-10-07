// /app/src/lib/productPairingValidation.ts
//
// Pure validation helpers for ProductPairing CRUD payloads. Split out so
// the admin API endpoints stay thin and the rules can be unit-tested
// without a database.

export interface ProductPairingInput {
  name?: unknown;
  description?: unknown;
  fromDepartmentId?: unknown;
  fromCategoryId?: unknown;
  toDepartmentId?: unknown;
  toCategoryId?: unknown;
  windowDays?: unknown;
  isActive?: unknown;
  sortOrder?: unknown;
}

export interface ValidatedProductPairing {
  name: string;
  description: string | null;
  fromDepartmentId: number;
  fromCategoryId: number | null;
  toDepartmentId: number;
  toCategoryId: number | null;
  windowDays: number;
  isActive: boolean;
  sortOrder: number;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  data?: ValidatedProductPairing;
}

function asInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined) return fallback;
  return false;
}

export function validateProductPairingInput(input: ProductPairingInput): ValidationResult {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > 120) return { ok: false, error: "Name must be 120 characters or fewer" };

  const fromDepartmentId = asInt(input.fromDepartmentId);
  if (fromDepartmentId === null || fromDepartmentId <= 0) {
    return { ok: false, error: "From department is required" };
  }

  const toDepartmentId = asInt(input.toDepartmentId);
  if (toDepartmentId === null || toDepartmentId <= 0) {
    return { ok: false, error: "To department is required" };
  }

  const fromCategoryId = asInt(input.fromCategoryId);
  const toCategoryId = asInt(input.toCategoryId);

  // Reject "same dept, same cat" -- that's an empty segment by definition
  // (a customer can't have bought X and not bought X). Different depts or
  // different categories within a dept is fine.
  if (fromDepartmentId === toDepartmentId && (fromCategoryId ?? null) === (toCategoryId ?? null)) {
    return {
      ok: false,
      error: "From and To cannot be the same department and category",
    };
  }

  const rawWindow = asInt(input.windowDays);
  const windowDays = rawWindow ?? 60;
  if (windowDays < 1 || windowDays > 730) {
    return { ok: false, error: "Window must be between 1 and 730 days" };
  }

  const rawSortOrder = asInt(input.sortOrder);
  const sortOrder = rawSortOrder ?? 0;

  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : null;

  return {
    ok: true,
    data: {
      name,
      description,
      fromDepartmentId,
      fromCategoryId,
      toDepartmentId,
      toCategoryId,
      windowDays,
      isActive: asBool(input.isActive, true),
      sortOrder,
    },
  };
}

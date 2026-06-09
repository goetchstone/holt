// /app/src/pages/api/tools/query-builder.ts
//
// Read-only query builder for managers. Accepts a JSON query config,
// executes a Prisma findMany with dynamic includes and filters,
// and returns flattened results. No raw SQL, no mutations.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { getEntityDef } from "@/lib/queryBuilderConfig";

const MAX_ROWS = 500;

interface QueryFilter {
  field: string;
  op: string;
  value: string;
}

interface QueryConfig {
  entity: string;
  joins: string[];
  filters: QueryFilter[];
  limit?: number;
}

function buildWhere(filters: QueryFilter[]): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const f of filters) {
    if (!f.field || !f.value) continue;

    // Handle nested fields (e.g., "vendor.name")
    const parts = f.field.split(".");
    if (parts.length > 1) {
      const [relation, field] = parts;
      if (!where[relation]) where[relation] = {};
      (where[relation] as Record<string, unknown>)[field] = buildFilterValue(f.op, f.value);
      continue;
    }

    where[f.field] = buildFilterValue(f.op, f.value);
  }
  return where;
}

function buildFilterValue(op: string, value: string): unknown {
  switch (op) {
    case "equals":
      if (value === "true") return true;
      if (value === "false") return false;
      if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
      return value;
    case "contains":
      return { contains: value, mode: "insensitive" };
    case "startsWith":
      return { startsWith: value, mode: "insensitive" };
    case "gt":
      return { gt: Number.isNaN(Date.parse(value)) ? Number.parseFloat(value) : new Date(value) };
    case "gte":
      return { gte: Number.isNaN(Date.parse(value)) ? Number.parseFloat(value) : new Date(value) };
    case "lt":
      return { lt: Number.isNaN(Date.parse(value)) ? Number.parseFloat(value) : new Date(value) };
    case "lte":
      return { lte: Number.isNaN(Date.parse(value)) ? Number.parseFloat(value) : new Date(value) };
    case "not":
      return { not: value };
    default:
      return value;
  }
}

function buildInclude(
  joins: string[],
  entityDef: ReturnType<typeof getEntityDef>,
): Record<string, unknown> | undefined {
  if (!entityDef || joins.length === 0) return undefined;

  const include: Record<string, unknown> = {};
  for (const joinName of joins) {
    const joinDef = entityDef.joins.find((j) => j.relation === joinName);
    if (!joinDef) continue;

    // Build select from the join's column definitions
    const selectFields: Record<string, boolean> = {};
    for (const col of joinDef.columns) {
      const fieldName = col.field.split(".").pop();
      if (fieldName) selectFields[fieldName] = true;
    }

    include[joinName] = { select: selectFields };
  }

  return Object.keys(include).length > 0 ? include : undefined;
}

// Flatten nested objects for table display
function flattenRow(row: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(result, flattenRow(value as Record<string, unknown>, fullKey));
    } else if (Array.isArray(value)) {
      // For array relations (like lineItems), show count
      result[`${fullKey}._count`] = value.length;
      // Also flatten first item for preview
      if (value.length > 0 && typeof value[0] === "object") {
        for (const item of value) {
          const flatItem = flattenRow(item as Record<string, unknown>, fullKey);
          for (const [k, v] of Object.entries(flatItem)) {
            if (!result[k]) result[k] = v;
          }
        }
      }
    } else {
      // Convert Decimals and Dates to display values
      if (value !== null && value !== undefined) {
        const str = String(value);
        if (str.match(/^\d{4}-\d{2}-\d{2}T/)) {
          result[fullKey] = str.slice(0, 10);
        } else {
          result[fullKey] = typeof value === "bigint" ? Number(value) : value;
        }
      } else {
        result[fullKey] = null;
      }
    }
  }
  return result;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = (session as any)?.role;
  if (role !== "ADMIN") return res.status(403).json({ error: "Admin only" });

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const config = req.body as QueryConfig;
  if (!config?.entity) return res.status(400).json({ error: "entity is required" });

  const entityDef = getEntityDef(config.entity);
  if (!entityDef) return res.status(400).json({ error: `Unknown entity: ${config.entity}` });

  try {
    const modelName = entityDef.prismaModel as keyof typeof prisma;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (prisma as any)[modelName];

    const where = buildWhere(config.filters || []);
    const include = buildInclude(config.joins || [], entityDef);
    const limit = Math.min(config.limit || 100, MAX_ROWS);

    const rows = await model.findMany({
      where,
      include,
      take: limit,
      orderBy: { [entityDef.defaultOrderBy]: "desc" },
    });

    // Flatten and convert Decimal/Date types for JSON
    const flatRows = (rows as Record<string, unknown>[]).map((row) => {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && typeof value === "object" && "toNumber" in (value as object)) {
          converted[key] = Number(value);
        } else {
          converted[key] = value;
        }
      }
      return flattenRow(converted);
    });

    // Collect all column keys from the results
    const columnKeys = new Set<string>();
    for (const row of flatRows) {
      for (const key of Object.keys(row)) {
        columnKeys.add(key);
      }
    }

    return res.json({
      entity: config.entity,
      rowCount: flatRows.length,
      totalAvailable: limit === flatRows.length ? `${limit}+ (limited)` : flatRows.length,
      columns: Array.from(columnKeys),
      rows: flatRows,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

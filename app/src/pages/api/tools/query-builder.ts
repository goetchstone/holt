// /app/src/pages/api/tools/query-builder.ts
//
// Read-only query builder for managers. Accepts a JSON query config,
// executes a Prisma findMany with dynamic includes and filters,
// and returns flattened results. No raw SQL, no mutations.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getEntityDef } from "@/lib/queryBuilderConfig";
import { buildInclude, buildWhere } from "@/lib/queryBuilderQuery";
import { logError } from "@/lib/logger";

const MAX_ROWS = 500;

interface QueryConfig {
  entity: string;
  joins?: unknown;
  filters?: unknown;
  limit?: number;
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

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const config = req.body as QueryConfig;
  if (!config?.entity) return res.status(400).json({ error: "entity is required" });

  const entityDef = getEntityDef(config.entity);
  if (!entityDef) return res.status(400).json({ error: `Unknown entity: ${config.entity}` });

  try {
    const modelName = entityDef.prismaModel as keyof typeof prisma;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (prisma as any)[modelName];

    // Field names are resolved against entityDef; see lib/queryBuilderQuery.ts.
    const built = buildWhere(config.filters, entityDef);
    if (!built.ok) return res.status(400).json({ error: built.error });
    const where = built.where;
    const include = buildInclude(config.joins, entityDef);
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
    // A 500 says what failed, not why: Prisma's message names models and
    // columns (CLAUDE.md rule 11). The operator reads it in the log.
    logError("Query builder query failed", err, { entity: config.entity });
    return res.status(500).json({ error: "Query failed" });
  }
}

export default requireAuthWithRole(["ADMIN"], handler);

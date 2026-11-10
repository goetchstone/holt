// /app/src/pages/api/tools/query-builder.ts
//
// Read-only query builder (ad-hoc reporting, GAP-34, DECISIONS 53). Takes a JSON query
// config and answers with a list of rows, or with `summary`, a table of totals. Only
// what lib/queryBuilderConfig.ts names can be read, filtered or totalled. No raw SQL,
// no mutations.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { auditActor, auditLog } from "@/lib/audit";
import { VIEW_COST, canViewCost } from "@/lib/auth/costVisibility";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { entityFor, getEntityDef } from "@/lib/queryBuilderConfig";
import { buildSelect, buildWhere, flattenRow, selectFromPaths } from "@/lib/queryBuilderQuery";
import {
  SUMMARY_MAX_ROWS,
  parseSummaryRequest,
  summarize,
  summaryPaths,
} from "@/lib/queryBuilderSummary";

const MAX_ROWS = 500;
const DEFAULT_ROWS = 100;
const EXPORT = "reporting.export";

interface QueryConfig {
  entity: string;
  joins?: unknown;
  filters?: unknown;
  limit?: unknown;
  summary?: unknown;
  /** The rows are for a file. Needs `reporting.export`, and goes in the audit trail. */
  export?: unknown;
}

function rowLimit(limit: unknown): number {
  const asked = typeof limit === "number" && limit >= 1 ? Math.floor(limit) : DEFAULT_ROWS;
  return Math.min(asked, MAX_ROWS);
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const config = req.body as QueryConfig;
  if (!config?.entity) return res.status(400).json({ error: "entity is required" });

  const offered = getEntityDef(config.entity);
  if (!offered) return res.status(400).json({ error: `Unknown entity: ${config.entity}` });
  const entity = entityFor(offered, canViewCost(access));

  const exporting = config.export === true;
  if (exporting && !access.holds[EXPORT]) {
    return res.status(403).json({ error: "Your role can't export data. Ask someone who can." });
  }

  try {
    const timeZone = await getBusinessTimeZone();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (prisma as any)[entity.prismaModel];

    // Field names are resolved against the entity; see lib/queryBuilderQuery.ts.
    const built = buildWhere(config.filters, entity, timeZone);
    if (!built.ok) return res.status(400).json({ error: built.error });

    const recordExport = async (rowCount: number) => {
      if (!exporting) return;
      await auditLog("DATA_EXPORTED", auditActor(session), {
        summary: `${entity.label} exported from the query builder: ${rowCount} rows`,
        details: { entity: entity.key, totals: config.summary !== undefined },
      });
    };

    if (config.summary !== undefined) {
      const parsed = parseSummaryRequest(config.summary, entity);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const rows = await model.findMany({
        where: { AND: [built.where, entity.totals.where] },
        select: selectFromPaths(summaryPaths(parsed.request)),
        take: SUMMARY_MAX_ROWS + 1,
      });
      if (rows.length > SUMMARY_MAX_ROWS) {
        return res.status(400).json({
          error: `This covers more than ${SUMMARY_MAX_ROWS.toLocaleString("en-US")} rows, too many to total. Narrow it with a filter, such as a date range.`,
        });
      }
      const table = summarize(rows, entity, parsed.request, timeZone);
      await recordExport(table.rows.length);
      return res.json({ entity: entity.key, table });
    }

    const limit = rowLimit(config.limit);
    const rows = (await model.findMany({
      where: built.where,
      select: buildSelect(config.joins, entity),
      take: limit,
      orderBy: { [entity.defaultOrderBy]: "desc" },
    })) as Record<string, unknown>[];

    const flatRows = rows.map((row) => flattenRow(row, timeZone));
    const columnKeys = new Set(flatRows.flatMap((row) => Object.keys(row)));
    await recordExport(flatRows.length);

    return res.json({
      entity: entity.key,
      rowCount: flatRows.length,
      totalAvailable: limit === flatRows.length ? `${limit}+ (limited)` : flatRows.length,
      columns: Array.from(columnKeys),
      rows: flatRows,
    });
  } catch (err: unknown) {
    // A 500 says what failed, not why: Prisma's message names models and
    // columns (CLAUDE.md rule 11). The operator reads it in the log.
    logError("Query builder query failed", err, { entity: entity.key });
    return res.status(500).json({ error: "Query failed" });
  }
}

export default requirePermission("reporting.adhoc", handler, { also: [VIEW_COST, EXPORT] });

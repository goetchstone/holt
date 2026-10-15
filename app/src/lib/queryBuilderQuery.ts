// /app/src/lib/queryBuilderQuery.ts
//
// Turns a query-builder request into Prisma `where` and `include` arguments.
// Pure, so the property that matters is tested directly
// (__tests__/queryBuilderQuery.test.ts): every property NAME written into
// those objects comes from the entity's definition in queryBuilderConfig.ts,
// never from the request body.
//
// It used to come from the body. A filter field was split on "." and written
// as `where[relation][field] = ...`, so `{ field: "__proto__.x" }` assigned
// Object.prototype.x for the whole server process (CodeQL
// js/prototype-polluting-assignment #19, js/remote-property-injection
// #39-#42), and any column of the entity or a relation could be filtered on,
// not just the ones the screen offers. Filters are now resolved against
// EntityDef.filters, the same list the UI builds its dropdown from, and an
// unknown field is a 400 rather than a silently dropped filter: a result set
// that ignored a filter the caller asked for would read as filtered.

import type { EntityDef } from "@/lib/queryBuilderConfig";

export type BuildWhereResult =
  { ok: true; where: Record<string, unknown> } | { ok: false; error: string };

export function buildFilterValue(op: string, value: string): unknown {
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

/** `filters` is the request body's value, unvalidated. */
export function buildWhere(filters: unknown, entityDef: EntityDef): BuildWhereResult {
  if (filters === undefined || filters === null) return { ok: true, where: {} };
  if (!Array.isArray(filters)) return { ok: false, error: "filters must be an array" };

  const where: Record<string, unknown> = {};
  for (const filter of filters) {
    if (typeof filter !== "object" || filter === null) {
      return { ok: false, error: "each filter must be an object" };
    }
    const { field, op, value } = filter as Record<string, unknown>;
    // A row the user added but left blank: the screen sends none, but an
    // empty filter has always meant "no filter".
    if (!field || !value) continue;

    const def = entityDef.filters.find((d) => d.field === field);
    if (!def) return { ok: false, error: `Unknown filter field: ${JSON.stringify(field)}` };
    if (typeof value !== "string") {
      return { ok: false, error: `Filter value for ${def.field} must be a string` };
    }

    // Keys from def.field (configuration), never from `field` (the request).
    const parts = def.field.split(".");
    if (parts.length > 1) {
      const [relation, column] = parts;
      const nested = (where[relation] ?? {}) as Record<string, unknown>;
      nested[column] = buildFilterValue(String(op), value);
      where[relation] = nested;
      continue;
    }
    where[def.field] = buildFilterValue(String(op), value);
  }
  return { ok: true, where };
}

/** `joins` is the request body's value, unvalidated. An unknown join is
 *  skipped: it only adds columns, so dropping one cannot misstate a result. */
export function buildInclude(
  joins: unknown,
  entityDef: EntityDef,
): Record<string, unknown> | undefined {
  if (!Array.isArray(joins) || joins.length === 0) return undefined;

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

    include[joinDef.relation] = { select: selectFields };
  }

  return Object.keys(include).length > 0 ? include : undefined;
}

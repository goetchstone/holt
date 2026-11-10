// /app/src/lib/queryBuilderQuery.ts
//
// Turns a query-builder request into Prisma `where` and `select` arguments, and its
// rows into flat ones for the table. Pure, so the property that matters is tested
// directly (__tests__/queryBuilderQuery.test.ts): every property NAME written into
// those objects comes from the entity's definition in queryBuilderConfig.ts, never
// from the request body.
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

import { FILTER_OPS, type EntityDef, type FilterOption } from "@/lib/queryBuilderConfig";
import { businessDayKey, businessDayRange, isDayKey } from "@/lib/reports/businessDay";

export type BuildWhereResult =
  { ok: true; where: Record<string, unknown> } | { ok: false; error: string };

type Condition = { ok: true; condition: Record<string, unknown> } | { ok: false; error: string };

/** A day in the store's time, as a range of instants (lib/reports/businessDay.ts). */
function dayCondition(op: string, day: string, timeZone: string): Record<string, Date> {
  const { gte, lt } = businessDayRange(day, timeZone);
  switch (op) {
    case "gt":
      return { gte: lt };
    case "gte":
      return { gte };
    case "lt":
      return { lt: gte };
    case "lte":
      return { lt };
    default:
      return { gte, lt };
  }
}

function comparison(op: string, value: string | number | boolean): unknown {
  switch (op) {
    case "contains":
    case "startsWith":
      return { [op]: value, mode: "insensitive" };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { [op]: value };
    default:
      return value;
  }
}

function typedValue(def: FilterOption, value: string): string | number | boolean | null {
  if (def.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (def.type === "select" && (value === "true" || value === "false")) return value === "true";
  return value;
}

/** The condition on the column, before its relations are wrapped around it. */
function columnCondition(
  def: FilterOption,
  op: string,
  value: string,
  timeZone: string,
): Condition {
  const offered: readonly string[] = FILTER_OPS[def.type];
  if (!offered.includes(op)) {
    return { ok: false, error: `${def.label} can't be filtered with ${JSON.stringify(op)}` };
  }
  const column = def.field.split(".").pop() as string;

  if (def.type === "date") {
    if (!isDayKey(value)) return { ok: false, error: `${def.label} needs a date (YYYY-MM-DD)` };
    return { ok: true, condition: { [column]: dayCondition(op, value, timeZone) } };
  }

  const typed = typedValue(def, value);
  if (typed === null) return { ok: false, error: `${def.label} needs a number` };
  if (op !== "not") return { ok: true, condition: { [column]: comparison(op, typed) } };

  // NULL is neither equal nor unequal to anything, so a bare `not` drops those rows (rule 51).
  return {
    ok: true,
    condition: def.nullable
      ? { OR: [{ [column]: null }, { [column]: { not: typed } }] }
      : { [column]: { not: typed } },
  };
}

/**
 * `filters` is the request body's value, unvalidated. Each filter is its own condition,
 * so two on one column make a range rather than the second replacing the first.
 */
export function buildWhere(
  filters: unknown,
  entityDef: EntityDef,
  timeZone: string,
): BuildWhereResult {
  if (filters === undefined || filters === null) return { ok: true, where: {} };
  if (!Array.isArray(filters)) return { ok: false, error: "filters must be an array" };

  const conditions: Record<string, unknown>[] = [];
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

    const built = columnCondition(def, String(op), value, timeZone);
    if (!built.ok) return built;
    // Keys from def.field (configuration), never from `field` (the request).
    const relations = def.field.split(".").slice(0, -1);
    conditions.push(
      relations.reduceRight<Record<string, unknown>>(
        (inner, relation) => ({ [relation]: inner }),
        built.condition,
      ),
    );
  }
  if (conditions.length === 0) return { ok: true, where: {} };
  return { ok: true, where: conditions.length === 1 ? conditions[0] : { AND: conditions } };
}

/** A Prisma `select` for dotted paths. Pass only names from the entity's definition. */
export function selectFromPaths(paths: string[]): Record<string, unknown> {
  const select: Record<string, unknown> = {};
  for (const path of paths) {
    const parts = path.split(".");
    const column = parts.pop() as string;
    let node = select;
    for (const relation of parts) {
      const existing = node[relation] as { select: Record<string, unknown> } | undefined;
      const next = existing ?? { select: {} };
      node[relation] = next;
      node = next.select;
    }
    node[column] = true;
  }
  return select;
}

/**
 * What a list of rows reads: the entity's columns and the joins asked for, and nothing
 * else. A model's other columns never leave the database. `joins` is the request body's
 * value, unvalidated. An unknown join is skipped: it only adds columns, so dropping one
 * cannot misstate a result.
 */
export function buildSelect(joins: unknown, entityDef: EntityDef): Record<string, unknown> {
  const asked = Array.isArray(joins) ? joins : [];
  const joined = entityDef.joins.filter((j) => asked.includes(j.relation));
  return selectFromPaths([
    ...entityDef.columns.map((c) => c.field),
    ...joined.flatMap((j) => j.columns.map((c) => c.field)),
  ]);
}

function isDecimal(value: object): boolean {
  return typeof (value as { toNumber?: unknown }).toNumber === "function";
}

/** One row as a flat object for the table. A to-many relation shows its count and first values. */
export function flattenRow(
  row: Record<string, unknown>,
  timeZone: string,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      result[fullKey] = null;
    } else if (value instanceof Date) {
      result[fullKey] = businessDayKey(value, timeZone);
    } else if (typeof value === "bigint") {
      result[fullKey] = Number(value);
    } else if (Array.isArray(value)) {
      result[`${fullKey}._count`] = value.length;
      for (const item of value) {
        for (const [k, v] of Object.entries(flattenRow(item, timeZone, fullKey))) {
          if (!result[k]) result[k] = v;
        }
      }
    } else if (typeof value === "object") {
      if (isDecimal(value)) result[fullKey] = Number(value);
      else Object.assign(result, flattenRow(value as Record<string, unknown>, timeZone, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

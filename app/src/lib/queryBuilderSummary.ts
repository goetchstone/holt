// /app/src/lib/queryBuilderSummary.ts
//
// Grouping, totals and pivot for the query builder (GAP-34, DECISIONS 53). Pure: the
// route reads the rows, this adds them up, and the answer is a table the screen and
// the CSV both print as it stands.
//
// Rows are read and added up here rather than in SQL, so a group can reach through a
// relation and a month can follow the store's time zone. The route reads up to
// SUMMARY_MAX_ROWS and refuses past that, because a total over part of the rows would
// read as a total over all of them.

import {
  COUNT_MEASURE,
  type EntityDef,
  type GroupDef,
  type MeasureDef,
} from "@/lib/queryBuilderConfig";
import { businessDayKey } from "@/lib/reports/businessDay";

export const SUMMARY_MAX_ROWS = 100_000;

/** A group's name for rows with nothing in that column. They stay in the totals (rule 51). */
export const NO_VALUE = "(none)";

export interface SummaryRequest {
  group: GroupDef;
  across: GroupDef | null;
  measures: MeasureDef[];
}

export interface SummaryColumn {
  label: string;
  type: "string" | "number" | "decimal";
}

export interface SummaryTable {
  columns: SummaryColumn[];
  rows: (string | number)[][];
  footer: (string | number)[];
  rowsRead: number;
  population: string;
}

export type SummaryParse = { ok: true; request: SummaryRequest } | { ok: false; error: string };

function countMeasure(entity: EntityDef): MeasureDef {
  return {
    key: COUNT_MEASURE,
    label: entity.totals.countLabel,
    type: "number",
    field: COUNT_MEASURE,
  };
}

/** Everything an entity can total, the count first. */
export function measuresOf(entity: EntityDef): MeasureDef[] {
  return [countMeasure(entity), ...entity.totals.measures];
}

/** `raw` is the request body's value, unvalidated. Names resolve against the entity's list. */
export function parseSummaryRequest(raw: unknown, entity: EntityDef): SummaryParse {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "summary must be an object" };
  }
  const { groupBy, across, measures } = raw as Record<string, unknown>;

  const group = entity.totals.groups.find((g) => g.key === groupBy);
  if (!group) return { ok: false, error: `Unknown group: ${JSON.stringify(groupBy)}` };

  const acrossGroup = across ? entity.totals.groups.find((g) => g.key === across) : null;
  if (acrossGroup === undefined) {
    return { ok: false, error: `Unknown group: ${JSON.stringify(across)}` };
  }
  if (acrossGroup?.key === group.key) {
    return { ok: false, error: "Pick a different group to go across." };
  }

  if (!Array.isArray(measures) || measures.length === 0) {
    return { ok: false, error: "Pick something to total." };
  }
  const offered = measuresOf(entity);
  const picked: MeasureDef[] = [];
  for (const key of measures) {
    const measure = offered.find((m) => m.key === key);
    if (!measure) return { ok: false, error: `Unknown total: ${JSON.stringify(key)}` };
    picked.push(measure);
  }
  if (acrossGroup && picked.length > 1) {
    return { ok: false, error: "Going across shows one total at a time." };
  }
  return { ok: true, request: { group, across: acrossGroup, measures: picked } };
}

/** The columns a summary has to read, for lib/queryBuilderQuery.ts's selectFromPaths. */
export function summaryPaths(request: SummaryRequest): string[] {
  const paths = [request.group.path];
  if (request.across) paths.push(request.across.path);
  for (const measure of request.measures) {
    if (measure.key === COUNT_MEASURE) continue;
    paths.push(measure.field);
    if (measure.times) paths.push(measure.times);
  }
  return paths;
}

function readPath(row: Record<string, unknown>, path: string): unknown {
  let value: unknown = row;
  for (const part of path.split(".")) {
    if (value === null || value === undefined) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function groupLabel(row: Record<string, unknown>, group: GroupDef, timeZone: string): string {
  const value = readPath(row, group.path);
  if (value === null || value === undefined || value === "") return NO_VALUE;
  if (group.bucket === "month") return businessDayKey(value as Date, timeZone).slice(0, 7);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function measureValue(row: Record<string, unknown>, measure: MeasureDef): number {
  if (measure.key === COUNT_MEASURE) return 1;
  const value = Number(readPath(row, measure.field) ?? 0);
  return measure.times ? value * Number(readPath(row, measure.times) ?? 0) : value;
}

/** Money to the cent, quantities to the thousandth (they're stored fractional). */
function rounded(value: number, measure: MeasureDef): number {
  const factor = measure.type === "decimal" ? 100 : 1000;
  return Math.round(value * factor) / factor;
}

/** A to Z, numbers in order, and rows with no value last. */
function sortedLabels(labels: Iterable<string>): string[] {
  return [...labels].sort((a, b) => {
    if (a === NO_VALUE) return 1;
    if (b === NO_VALUE) return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

export function summarize(
  rows: Record<string, unknown>[],
  entity: EntityDef,
  request: SummaryRequest,
  timeZone: string,
): SummaryTable {
  const { group, across, measures } = request;
  // group label -> across label ("" with no pivot) -> one running sum per measure
  const sums = new Map<string, Map<string, number[]>>();
  const acrossLabels = new Set<string>();

  for (const row of rows) {
    const label = groupLabel(row, group, timeZone);
    const acrossLabel = across ? groupLabel(row, across, timeZone) : "";
    acrossLabels.add(acrossLabel);
    const byAcross = sums.get(label) ?? new Map<string, number[]>();
    sums.set(label, byAcross);
    const cell = byAcross.get(acrossLabel) ?? measures.map(() => 0);
    byAcross.set(acrossLabel, cell);
    measures.forEach((measure, i) => {
      cell[i] += measureValue(row, measure);
    });
  }

  const base = { rowsRead: rows.length, population: entity.totals.says };
  const groupColumn: SummaryColumn = { label: group.label, type: "string" };

  if (!across) {
    const totals = measures.map(() => 0);
    const tableRows = sortedLabels(sums.keys()).map((label) => {
      const cell = sums.get(label)?.get("") ?? [];
      cell.forEach((value, i) => {
        totals[i] += value;
      });
      return [label, ...cell.map((value, i) => rounded(value, measures[i]))];
    });
    return {
      ...base,
      columns: [groupColumn, ...measures.map((m) => ({ label: m.label, type: m.type }))],
      rows: tableRows,
      footer: ["Total", ...totals.map((value, i) => rounded(value, measures[i]))],
    };
  }

  const measure = measures[0];
  const headings = sortedLabels(acrossLabels);
  const columnTotals = headings.map(() => 0);
  let grandTotal = 0;
  const tableRows = sortedLabels(sums.keys()).map((label) => {
    let rowTotal = 0;
    const cells = headings.map((heading, i) => {
      const value = sums.get(label)?.get(heading)?.[0] ?? 0;
      rowTotal += value;
      columnTotals[i] += value;
      return rounded(value, measure);
    });
    grandTotal += rowTotal;
    return [label, ...cells, rounded(rowTotal, measure)];
  });
  return {
    ...base,
    columns: [
      groupColumn,
      ...headings.map((label) => ({ label, type: measure.type })),
      { label: "Total", type: measure.type },
    ],
    rows: tableRows,
    footer: [
      "Total",
      ...columnTotals.map((value) => rounded(value, measure)),
      rounded(grandTotal, measure),
    ],
  };
}

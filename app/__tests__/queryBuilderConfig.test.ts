// /app/__tests__/queryBuilderConfig.test.ts
//
// The query builder's list is its security model, and the server now reads what it
// names, so a wrong name is a 500 on a report. For years the columns were only labels on
// a screen, so nothing compared them with the schema. This does, in both directions where
// there are two (rule 65): every name exists, cost is flagged and nothing else is, the
// status lists match their enums, and "not equal" knows which columns hold NULL (rule 51).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITIES, entityFor, FILTER_OPS, getEntityDef } from "@/lib/queryBuilderConfig";

interface Field {
  type: string;
  optional: boolean;
  list: boolean;
  dbDate: boolean;
}

const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");

const models = new Map<string, Map<string, Field>>();
for (const [, name, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const fields = new Map<string, Field>();
  for (const [line, field, type, list, optional] of body.matchAll(
    /^\s+(\w+)\s+(\w+)(\[\])?(\?)?.*$/gm,
  )) {
    fields.set(field, {
      type,
      optional: optional === "?",
      list: list === "[]",
      dbDate: line.includes("@db.Date"),
    });
  }
  models.set(name, fields);
}

const enums = new Map<string, string[]>();
for (const [, name, body] of schema.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
  enums.set(
    name,
    body
      .split("\n")
      .map((line) => line.trim().split(/\s/)[0])
      .filter((value) => /^[A-Z_0-9]+$/i.test(value)),
  );
}

const modelOf = (prismaModel: string) => prismaModel[0].toUpperCase() + prismaModel.slice(1);

/** The field a dotted path ends at. Throws on a name the schema doesn't have. */
function resolve(model: string, path: string, { toOneOnly = true } = {}): Field {
  const parts = path.split(".");
  let current = model;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) return;
    const relation = models.get(current)?.get(part);
    if (!relation || !models.has(relation.type)) {
      throw new Error(`${current}.${part} isn't a relation, on the way to ${path}`);
    }
    if (toOneOnly && relation.list) {
      throw new Error(`${current}.${part} is to-many, so ${path} has no single value`);
    }
    current = relation.type;
  });
  const field = models.get(current)?.get(parts[parts.length - 1]);
  if (!field) throw new Error(`${current} has no ${parts[parts.length - 1]}, from ${path}`);
  return field;
}

const isScalar = (field: Field) => !models.has(field.type);
const STORE_PAYS = /cost|anchorPrice/i;

describe.each(ENTITIES.map((e) => [e.key, e] as const))("%s", (_key, entity) => {
  const model = modelOf(entity.prismaModel);

  it("is a model", () => {
    expect(models.has(model)).toBe(true);
  });

  it("orders by a column it has", () => {
    expect(isScalar(resolve(model, entity.defaultOrderBy))).toBe(true);
  });

  it("names columns that exist, and are columns", () => {
    for (const column of entity.columns) {
      expect(column.field).not.toContain(".");
      expect(isScalar(resolve(model, column.field))).toBe(true);
    }
  });

  it("names joins that exist, whose columns sit on that relation", () => {
    for (const join of entity.joins) {
      expect(models.has(resolve(model, join.relation).type)).toBe(true);
      for (const column of join.columns) {
        expect(column.field.split(".")[0]).toBe(join.relation);
        expect(isScalar(resolve(model, column.field, { toOneOnly: false }))).toBe(true);
      }
    }
  });

  it("filters by the column's own type, through to-one relations", () => {
    for (const filter of entity.filters) {
      const field = resolve(model, filter.field);
      const isEnum = enums.has(field.type);
      const expected =
        field.type === "DateTime"
          ? "date"
          : field.type === "Int" || field.type === "Decimal"
            ? "number"
            : isEnum || field.type === "Boolean"
              ? "select"
              : "string";
      expect(`${filter.field} ${filter.type}`).toBe(`${filter.field} ${expected}`);
    }
  });

  it("knows which filter columns hold NULL, both ways", () => {
    for (const filter of entity.filters) {
      const optional = resolve(model, filter.field).optional;
      expect(`${filter.field} ${Boolean(filter.nullable)}`).toBe(`${filter.field} ${optional}`);
    }
  });

  it("lists every status its column has, and no others", () => {
    for (const filter of entity.filters) {
      const field = resolve(model, filter.field);
      if (enums.has(field.type)) {
        expect([...(filter.options ?? [])].sort()).toEqual(
          [...(enums.get(field.type) ?? [])].sort(),
        );
      }
      if (field.type === "Boolean") expect(filter.options).toEqual(["true", "false"]);
    }
  });

  it("flags what the store pays, and nothing else", () => {
    const shown = [...entity.columns, ...entity.joins.flatMap((j) => j.columns)];
    for (const column of shown) {
      expect(`${column.field} ${Boolean(column.cost)}`).toBe(
        `${column.field} ${STORE_PAYS.test(column.field)}`,
      );
    }
    for (const measure of entity.totals.measures) {
      const names = `${measure.field} ${measure.times ?? ""}`;
      expect(`${measure.key} ${Boolean(measure.cost)}`).toBe(
        `${measure.key} ${STORE_PAYS.test(names)}`,
      );
    }
  });

  it("offers no filter or group on what the store pays, which would give it away", () => {
    for (const filter of entity.filters) expect(filter.field).not.toMatch(STORE_PAYS);
    for (const group of entity.totals.groups) expect(group.path).not.toMatch(STORE_PAYS);
  });

  it("states who counts in its totals", () => {
    expect(entity.totals.says.length).toBeGreaterThan(5);
    expect(entity.totals.countLabel.length).toBeGreaterThan(0);
    for (const relationOrColumn of Object.keys(entity.totals.where)) {
      expect(() => resolve(model, relationOrColumn)).not.toThrow();
    }
  });

  it("has something to group by", () => {
    expect(entity.totals.groups.length).toBeGreaterThan(0);
    expect(new Set(entity.totals.groups.map((g) => g.key)).size).toBe(entity.totals.groups.length);
  });

  it("groups through to-one relations, by a column", () => {
    for (const group of entity.totals.groups) {
      const field = resolve(model, group.path);
      expect(isScalar(field)).toBe(true);
      if (group.bucket === "month") {
        expect(field.type).toBe("DateTime");
        // A date-only column is a calendar day already, and would land a day early.
        expect(field.dbDate).toBe(false);
      }
    }
  });

  it("totals numbers", () => {
    for (const measure of entity.totals.measures) {
      expect(["Decimal", "Int"]).toContain(resolve(model, measure.field).type);
      if (measure.times) expect(["Decimal", "Int"]).toContain(resolve(model, measure.times).type);
      expect(measure.key).not.toBe("count");
    }
  });
});

describe("the list as a whole", () => {
  it("covers service cases and transfers", () => {
    expect(getEntityDef("ServiceCase")).toBeDefined();
    expect(getEntityDef("InventoryTransfer")).toBeDefined();
  });

  it("gives each filter type at least one operator", () => {
    for (const ops of Object.values(FILTER_OPS)) expect(ops.length).toBeGreaterThan(0);
  });
});

describe("entityFor", () => {
  const lines = getEntityDef("OrderLineItem")!;
  const pos = getEntityDef("PurchaseOrder")!;

  it("takes out what the store pays for a caller without View cost", () => {
    const seen = entityFor(lines, false);
    expect(seen.columns.some((c) => c.field === "cost")).toBe(false);
    expect(seen.columns.some((c) => c.field === "netPrice")).toBe(true);
    expect(seen.totals.measures.some((m) => m.key === "cost")).toBe(false);
    expect(seen.totals.measures.some((m) => m.key === "netPrice")).toBe(true);
    const items = entityFor(pos, false).joins.find((j) => j.relation === "lineItems");
    expect(items?.columns.some((c) => c.field === "lineItems.unitCost")).toBe(false);
    expect(items?.columns.some((c) => c.field === "lineItems.partNo")).toBe(true);
  });

  it("leaves the entity whole for a caller with it", () => {
    expect(entityFor(lines, true)).toBe(lines);
  });
});

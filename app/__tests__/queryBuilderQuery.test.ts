// /app/__tests__/queryBuilderQuery.test.ts
//
// The query builder writes request-supplied filters into Prisma `where` and
// `select` objects. Before lib/queryBuilderQuery.ts the property NAMES came
// from the request: `{ field: "__proto__.polluted" }` set
// Object.prototype.polluted for the whole process (CodeQL
// js/prototype-polluting-assignment #19, js/remote-property-injection
// #39-#42), and any column could be filtered on. Now every name comes from the
// entity's definition.

import { getEntityDef, type EntityDef } from "@/lib/queryBuilderConfig";
import { buildSelect, buildWhere, flattenRow, selectFromPaths } from "@/lib/queryBuilderQuery";

const TZ = "America/New_York";

const customer = getEntityDef("Customer") as EntityDef;
const salesOrder = getEntityDef("SalesOrder") as EntityDef;

afterEach(() => {
  // Belt and braces: if a regression did pollute, do not leak it into the
  // rest of the run.
  delete (Object.prototype as Record<string, unknown>).polluted;
});

describe("buildWhere", () => {
  it("builds a filter on a field the entity offers", () => {
    const result = buildWhere(
      [{ field: "email", op: "contains", value: "@example.com" }],
      customer,
      TZ,
    );
    expect(result).toEqual({
      ok: true,
      where: { email: { contains: "@example.com", mode: "insensitive" } },
    });
  });

  it("cannot reach Object.prototype through a dotted field", () => {
    const result = buildWhere(
      [{ field: "__proto__.polluted", op: "equals", value: "yes" }],
      customer,
      TZ,
    );
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(["__proto__", "constructor", "passwordHash", "addresses.street"])(
    "refuses %s, which the entity does not offer as a filter",
    (field) => {
      const result = buildWhere([{ field, op: "equals", value: "x" }], customer, TZ);
      expect(result).toEqual({
        ok: false,
        error: `Unknown filter field: ${JSON.stringify(field)}`,
      });
    },
  );

  it("refuses a column the entity has but does not offer as a filter", () => {
    // Customer.phone is a display column, not a filter: the screen never sends it.
    expect(buildWhere([{ field: "phone", op: "equals", value: "1" }], customer, TZ).ok).toBe(false);
  });

  it("skips a blank filter row, as it always has", () => {
    expect(buildWhere([{ field: "email", op: "equals", value: "" }], customer, TZ)).toEqual({
      ok: true,
      where: {},
    });
  });

  it("refuses a body whose filters are not an array of objects", () => {
    expect(buildWhere("email", customer, TZ).ok).toBe(false);
    expect(buildWhere([null], customer, TZ).ok).toBe(false);
    expect(buildWhere([{ field: "email", op: "equals", value: 7 }], customer, TZ).ok).toBe(false);
    expect(buildWhere(undefined, customer, TZ)).toEqual({ ok: true, where: {} });
  });
});

describe("buildWhere, by type", () => {
  const lines = getEntityDef("OrderLineItem") as EntityDef;
  const orders = getEntityDef("SalesOrder") as EntityDef;
  const pos = getEntityDef("PurchaseOrder") as EntityDef;
  const consignment = getEntityDef("ConsignmentItem") as EntityDef;
  const where = (entity: EntityDef, ...filters: object[]) => {
    const built = buildWhere(filters, entity, TZ);
    if (!built.ok) throw new Error(built.error);
    return built.where;
  };
  // Midnight Eastern, in November (UTC-5) and October (UTC-4).
  const nov1 = new Date("2026-11-01T04:00:00.000Z");
  const nov2 = new Date("2026-11-02T05:00:00.000Z");

  it("keeps both ends of a date range, instead of the second replacing the first", () => {
    expect(
      where(
        orders,
        { field: "orderDate", op: "gte", value: "2026-11-01" },
        { field: "orderDate", op: "lte", value: "2026-11-01" },
      ),
    ).toEqual({ AND: [{ orderDate: { gte: nov1 } }, { orderDate: { lt: nov2 } }] });
  });

  it.each([
    ["equals", { gte: nov1, lt: nov2 }],
    ["gte", { gte: nov1 }],
    ["gt", { gte: nov2 }],
    ["lt", { lt: nov1 }],
    ["lte", { lt: nov2 }],
  ])("reads a day in the store's time with %s", (op, expected) => {
    expect(where(orders, { field: "orderDate", op, value: "2026-11-01" })).toEqual({
      orderDate: expected,
    });
  });

  it("refuses a date that isn't one", () => {
    const built = buildWhere([{ field: "orderDate", op: "gte", value: "last week" }], orders, TZ);
    expect(built).toEqual({ ok: false, error: expect.stringContaining("needs a date") });
  });

  it("keeps a code made of digits as text on a text column", () => {
    expect(where(orders, { field: "orderno", op: "equals", value: "12345" })).toEqual({
      orderno: "12345",
    });
  });

  it("reads a number on a number column, and refuses what isn't one", () => {
    expect(where(lines, { field: "productId", op: "equals", value: "7" })).toEqual({
      productId: 7,
    });
    expect(where(pos, { field: "vendorId", op: "gt", value: "7" })).toEqual({
      vendorId: { gt: 7 },
    });
    expect(buildWhere([{ field: "vendorId", op: "gt", value: "x" }], pos, TZ)).toEqual({
      ok: false,
      error: expect.stringContaining("needs a number"),
    });
  });

  it("reads yes and no as true and false", () => {
    expect(where(consignment, { field: "creditOwed", op: "equals", value: "true" })).toEqual({
      creditOwed: true,
    });
    expect(where(consignment, { field: "creditOwed", op: "equals", value: "false" })).toEqual({
      creditOwed: false,
    });
  });

  it("matches text in any case", () => {
    expect(where(orders, { field: "orderno", op: "startsWith", value: "so" })).toEqual({
      orderno: { startsWith: "so", mode: "insensitive" },
    });
  });

  it("names NULL for not-equal on a column that can hold it (rule 51)", () => {
    expect(where(orders, { field: "salesperson", op: "not", value: "Sam" })).toEqual({
      OR: [{ salesperson: null }, { salesperson: { not: "Sam" } }],
    });
  });

  it("doesn't name NULL on a column that can't, which Prisma would refuse", () => {
    expect(where(orders, { field: "status", op: "not", value: "QUOTE" })).toEqual({
      status: { not: "QUOTE" },
    });
  });

  it("wraps a filter in its relation", () => {
    expect(where(lines, { field: "salesOrder.salesperson", op: "not", value: "Sam" })).toEqual({
      salesOrder: { OR: [{ salesperson: null }, { salesperson: { not: "Sam" } }] },
    });
  });

  it("refuses an operator the column's type doesn't take", () => {
    expect(buildWhere([{ field: "orderDate", op: "contains", value: "2026" }], orders, TZ)).toEqual(
      { ok: false, error: expect.stringContaining("can't be filtered") },
    );
    expect(buildWhere([{ field: "orderno", op: "__proto__", value: "1" }], orders, TZ).ok).toBe(
      false,
    );
  });
});

describe("selectFromPaths", () => {
  it("nests through relations and shares them", () => {
    expect(selectFromPaths(["id", "product.name", "product.vendor.name"])).toEqual({
      id: true,
      product: { select: { name: true, vendor: { select: { name: true } } } },
    });
  });
});

describe("buildSelect", () => {
  it("reads only the entity's columns", () => {
    const select = buildSelect([], customer);
    expect(select).toEqual({
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      tradeCompanyName: true,
    });
  });

  it("adds a relation the entity defines, keyed by its configured name", () => {
    expect(buildSelect(["customer"], salesOrder).customer).toEqual({
      select: { firstName: true, lastName: true },
    });
  });

  it("ignores a join the entity does not define, including prototype keys", () => {
    const plain = buildSelect([], salesOrder);
    expect(buildSelect(["__proto__", "constructor", "staffMember"], salesOrder)).toEqual(plain);
    expect(buildSelect("customer", salesOrder)).toEqual(plain);
  });

  it("leaves a joined relation out until it's asked for", () => {
    expect(buildSelect([], salesOrder).lineItems).toBeUndefined();
  });
});

describe("flattenRow", () => {
  const decimal = { toNumber: () => 12.5, toString: () => "12.5" };

  it("reads a Decimal as a number, on the row and through a join", () => {
    expect(
      flattenRow({ netPrice: decimal, salesOrder: { total: decimal, orderno: "SO-1" } }, TZ),
    ).toEqual({ netPrice: 12.5, "salesOrder.total": 12.5, "salesOrder.orderno": "SO-1" });
  });

  it("reads a date as the store's day", () => {
    expect(flattenRow({ orderDate: new Date("2026-11-01T00:30:00.000Z") }, TZ)).toEqual({
      orderDate: "2026-10-31",
    });
  });

  it("shows a to-many relation's count and first values, with Decimals as numbers", () => {
    expect(
      flattenRow(
        {
          lineItems: [
            { partNo: "A", netPrice: decimal },
            { partNo: "B", netPrice: decimal },
          ],
        },
        TZ,
      ),
    ).toEqual({ "lineItems._count": 2, "lineItems.partNo": "A", "lineItems.netPrice": 12.5 });
  });

  it("keeps an empty value, and a relation that isn't there", () => {
    expect(flattenRow({ email: null, vendor: null }, TZ)).toEqual({ email: null, vendor: null });
  });
});

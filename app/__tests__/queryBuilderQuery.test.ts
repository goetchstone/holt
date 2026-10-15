// /app/__tests__/queryBuilderQuery.test.ts
//
// The query builder writes request-supplied filters into Prisma `where` and
// `include` objects. Before lib/queryBuilderQuery.ts the property NAMES came
// from the request: `{ field: "__proto__.polluted" }` set
// Object.prototype.polluted for the whole process (CodeQL
// js/prototype-polluting-assignment #19, js/remote-property-injection
// #39-#42), and any column could be filtered on. Now every name comes from the
// entity's definition.

import { getEntityDef, type EntityDef } from "@/lib/queryBuilderConfig";
import { buildInclude, buildWhere } from "@/lib/queryBuilderQuery";

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
    );
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(["__proto__", "constructor", "passwordHash", "addresses.street"])(
    "refuses %s, which the entity does not offer as a filter",
    (field) => {
      const result = buildWhere([{ field, op: "equals", value: "x" }], customer);
      expect(result).toEqual({
        ok: false,
        error: `Unknown filter field: ${JSON.stringify(field)}`,
      });
    },
  );

  it("refuses a column the entity has but does not offer as a filter", () => {
    // Customer.phone is a display column, not a filter: the screen never sends it.
    expect(buildWhere([{ field: "phone", op: "equals", value: "1" }], customer).ok).toBe(false);
  });

  it("skips a blank filter row, as it always has", () => {
    expect(buildWhere([{ field: "email", op: "equals", value: "" }], customer)).toEqual({
      ok: true,
      where: {},
    });
  });

  it("refuses a body whose filters are not an array of objects", () => {
    expect(buildWhere("email", customer).ok).toBe(false);
    expect(buildWhere([null], customer).ok).toBe(false);
    expect(buildWhere([{ field: "email", op: "equals", value: 7 }], customer).ok).toBe(false);
    expect(buildWhere(undefined, customer)).toEqual({ ok: true, where: {} });
  });
});

describe("buildInclude", () => {
  it("includes a relation the entity defines, keyed by its configured name", () => {
    const include = buildInclude(["customer"], salesOrder);
    expect(include).toEqual({ customer: { select: expect.any(Object) } });
  });

  it("ignores a join the entity does not define, including prototype keys", () => {
    expect(buildInclude(["__proto__", "constructor", "staffMember"], salesOrder)).toBeUndefined();
    expect(buildInclude("customer", salesOrder)).toBeUndefined();
  });
});

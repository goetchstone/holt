// /app/__tests__/buildSearchFilter.test.ts

import { buildSearchFilter } from "../src/lib/buildSearchFilter";

describe("buildSearchFilter", () => {
  const CUSTOMER_FIELDS = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "externalIds.some.externalId",
  ];

  it("returns undefined for empty input", () => {
    expect(buildSearchFilter("", CUSTOMER_FIELDS)).toBeUndefined();
    expect(buildSearchFilter(null, CUSTOMER_FIELDS)).toBeUndefined();
    expect(buildSearchFilter(undefined, CUSTOMER_FIELDS)).toBeUndefined();
    expect(buildSearchFilter("   ", CUSTOMER_FIELDS)).toBeUndefined();
  });

  it("returns undefined when no field paths provided", () => {
    expect(buildSearchFilter("smith", [])).toBeUndefined();
  });

  it("builds a single-token OR across fields", () => {
    const result = buildSearchFilter("smith", CUSTOMER_FIELDS);
    expect(result).toEqual({
      AND: [
        {
          OR: [
            { firstName: { contains: "smith", mode: "insensitive" } },
            { lastName: { contains: "smith", mode: "insensitive" } },
            { email: { contains: "smith", mode: "insensitive" } },
            { phone: { contains: "smith", mode: "insensitive" } },
            {
              externalIds: {
                some: { externalId: { contains: "smith", mode: "insensitive" } },
              },
            },
          ],
        },
      ],
    });
  });

  it("builds AND of ORs for two tokens — the full-name case", () => {
    // "John Smith" — a customer with firstName=John, lastName=Smith matches
    // because token "john" hits firstName OR, token "smith" hits lastName OR.
    const result = buildSearchFilter("John Smith", ["firstName", "lastName", "email"]);
    expect(result).toEqual({
      AND: [
        {
          OR: [
            { firstName: { contains: "John", mode: "insensitive" } },
            { lastName: { contains: "John", mode: "insensitive" } },
            { email: { contains: "John", mode: "insensitive" } },
          ],
        },
        {
          OR: [
            { firstName: { contains: "Smith", mode: "insensitive" } },
            { lastName: { contains: "Smith", mode: "insensitive" } },
            { email: { contains: "Smith", mode: "insensitive" } },
          ],
        },
      ],
    });
  });

  it("handles multiple whitespace between tokens", () => {
    const result = buildSearchFilter("  John   Smith  ", ["firstName", "lastName"]);
    expect(result?.AND).toHaveLength(2);
    expect(result?.AND[0].OR[0]).toEqual({
      firstName: { contains: "John", mode: "insensitive" },
    });
    expect(result?.AND[1].OR[0]).toEqual({
      firstName: { contains: "Smith", mode: "insensitive" },
    });
  });

  it("builds nested one-to-one relation paths correctly", () => {
    const result = buildSearchFilter("acme", ["customer.firstName", "customer.lastName"]);
    expect(result).toEqual({
      AND: [
        {
          OR: [
            { customer: { firstName: { contains: "acme", mode: "insensitive" } } },
            { customer: { lastName: { contains: "acme", mode: "insensitive" } } },
          ],
        },
      ],
    });
  });

  it("builds `some` relation paths for many-to-many fields", () => {
    const result = buildSearchFilter("12345", ["upcs.some.upc"]);
    expect(result).toEqual({
      AND: [
        {
          OR: [{ upcs: { some: { upc: { contains: "12345", mode: "insensitive" } } } }],
        },
      ],
    });
  });

  it("preserves deeply nested relation paths", () => {
    const result = buildSearchFilter("jane", ["salesOrder.customer.firstName"]);
    expect(result).toEqual({
      AND: [
        {
          OR: [
            {
              salesOrder: {
                customer: { firstName: { contains: "jane", mode: "insensitive" } },
              },
            },
          ],
        },
      ],
    });
  });

  it("works with three tokens — partial full name", () => {
    const result = buildSearchFilter("John Q Smith", ["firstName", "lastName"]);
    expect(result?.AND).toHaveLength(3);
    expect(result?.AND.map((c) => c.OR[0])).toEqual([
      { firstName: { contains: "John", mode: "insensitive" } },
      { firstName: { contains: "Q", mode: "insensitive" } },
      { firstName: { contains: "Smith", mode: "insensitive" } },
    ]);
  });

  it("preserves token casing (mode:insensitive handles the match)", () => {
    const result = buildSearchFilter("JoHn", ["firstName"]);
    expect(result?.AND[0].OR[0]).toEqual({
      firstName: { contains: "JoHn", mode: "insensitive" },
    });
  });
});

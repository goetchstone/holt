// /app/__tests__/clientBook.test.ts
//
// The client book's query parsing, last-order bands and sort.

import {
  buildWorkedWithOptions,
  filterClientBook,
  parseClientBookOptions,
  sortClientBook,
  type ClientBookEntry,
} from "@/lib/clientBook";

const now = new Date("2026-11-04T12:00:00.000Z");

function entry(over: Partial<ClientBookEntry> = {}): ClientBookEntry {
  return {
    customerId: 1,
    firstName: "Pat",
    lastName: "Quote",
    lifetimeSpend: 0,
    ordersWithStaff: 1,
    lastOrderWithStaff: new Date("2026-10-01T00:00:00.000Z"),
    openQuotes: 0,
    hasNotes: false,
    ...over,
  };
}

describe("parseClientBookOptions", () => {
  it("defaults everything", () => {
    expect(parseClientBookOptions({})).toEqual({
      search: "",
      lastOrder: "all",
      notes: "all",
      sort: "recent",
      page: 1,
      workedWith: "",
    });
  });

  it("reads valid values and trims the search", () => {
    expect(
      parseClientBookOptions({
        search: "  summer home ",
        lastOrder: "over2y",
        notes: "withNotes",
        sort: "spend",
        page: "3",
      }),
    ).toEqual({
      search: "summer home",
      lastOrder: "over2y",
      notes: "withNotes",
      sort: "spend",
      page: 3,
      workedWith: "",
    });
  });

  it("falls back on unknown values and a bad page", () => {
    const options = parseClientBookOptions({ sort: "DROP TABLE", lastOrder: 5, page: "-2" });
    expect(options.sort).toBe("recent");
    expect(options.lastOrder).toBe("all");
    expect(options.page).toBe(1);
    expect(parseClientBookOptions({ page: "abc" }).page).toBe(1);
  });
});

describe("filterClientBook", () => {
  const ordered = (date: string) => entry({ lastOrderWithStaff: new Date(date) });
  const recent = ordered("2026-10-01T00:00:00.000Z");
  const nineMonths = ordered("2026-02-01T00:00:00.000Z");
  const eighteenMonths = ordered("2025-05-01T00:00:00.000Z");
  const threeYears = ordered("2023-11-01T00:00:00.000Z");
  const neverBought = entry({ ordersWithStaff: 0, lastOrderWithStaff: null });
  const all = [recent, nineMonths, eighteenMonths, threeYears, neverBought];
  const byLastOrder = (lastOrder: Parameters<typeof filterClientBook>[1]["lastOrder"]) =>
    filterClientBook(all, { lastOrder, notes: "all" }, now);

  it("places each client in exactly one last-order band", () => {
    expect(byLastOrder("all")).toHaveLength(5);
    expect(byLastOrder("within6m")).toEqual([recent]);
    expect(byLastOrder("6to12m")).toEqual([nineMonths]);
    expect(byLastOrder("1to2y")).toEqual([eighteenMonths]);
    expect(byLastOrder("over2y")).toEqual([threeYears]);
    expect(byLastOrder("never")).toEqual([neverBought]);
  });

  it("counts a date exactly on a boundary in the more recent band", () => {
    const sixMonthsToTheDay = ordered("2026-05-04T12:00:00.000Z");
    const inBand = (lastOrder: "within6m" | "6to12m") =>
      filterClientBook([sixMonthsToTheDay], { lastOrder, notes: "all" }, now);
    expect(inBand("within6m")).toHaveLength(1);
    expect(inBand("6to12m")).toHaveLength(0);
  });

  it("filters on whether notes exist", () => {
    const noted = entry({ hasNotes: true });
    const silent = entry({ hasNotes: false });
    expect(
      filterClientBook([noted, silent], { lastOrder: "all", notes: "withNotes" }, now),
    ).toEqual([noted]);
    expect(
      filterClientBook([noted, silent], { lastOrder: "all", notes: "withoutNotes" }, now),
    ).toEqual([silent]);
  });
});

describe("buildWorkedWithOptions", () => {
  const names = new Map([
    [1, new Set(["Tess", "FrontRegister1"])],
    [2, new Set(["Tess"])],
    [3, new Set(["FrontRegister1"])],
    [4, new Set(["Gwen"])],
  ]);

  it("counts each client under everyone they worked with, most clients first", () => {
    expect(buildWorkedWithOptions([1, 2, 3, 4], names, "")).toEqual([
      { name: "FrontRegister1", clientCount: 2 },
      { name: "Tess", clientCount: 2 },
      { name: "Gwen", clientCount: 1 },
    ]);
  });

  it("only counts the clients passed in", () => {
    expect(buildWorkedWithOptions([4], names, "")).toEqual([{ name: "Gwen", clientCount: 1 }]);
  });

  it("keeps a selected name listed after its clients are gone", () => {
    expect(buildWorkedWithOptions([], names, "Tess")).toEqual([{ name: "Tess", clientCount: 0 }]);
  });
});

describe("sortClientBook", () => {
  const adams = entry({
    customerId: 1,
    lastName: "Arden",
    lifetimeSpend: 500,
    lastOrderWithStaff: new Date("2025-01-01T00:00:00.000Z"),
  });
  const baker = entry({
    customerId: 2,
    lastName: "Brook",
    lifetimeSpend: 9000,
    lastOrderWithStaff: new Date("2026-01-01T00:00:00.000Z"),
  });
  const cole = entry({
    customerId: 3,
    lastName: "Cove",
    lifetimeSpend: 0,
    ordersWithStaff: 0,
    lastOrderWithStaff: null,
  });

  it("puts the most recent order first and never-bought clients last", () => {
    expect(sortClientBook([cole, adams, baker], "recent")).toEqual([baker, adams, cole]);
  });

  it("sorts by spend and by name", () => {
    expect(sortClientBook([adams, cole, baker], "spend")).toEqual([baker, adams, cole]);
    expect(sortClientBook([cole, baker, adams], "name")).toEqual([adams, baker, cole]);
  });

  it("sorts a client with no name without failing", () => {
    const nameless = entry({ firstName: null, lastName: null });
    expect(sortClientBook([adams, nameless], "name")).toHaveLength(2);
  });
});

// /app/__tests__/clientBook.test.ts
//
// The client book's query parsing, last-order bands and sort.

import {
  buildWorkedWithOptions,
  filterClientBook,
  parseClientBookOptions,
  sortClientBook,
  type ClientBookEntry,
  DEFAULT_OUTREACH_LAPSED_MONTHS,
  DEFAULT_OUTREACH_QUIET_DAYS,
  isSuggestedOutreach,
  readOutreachRules,
} from "@/lib/clientBook";

const now = new Date("2026-11-04T12:00:00.000Z");
const context = { now, timeZone: "UTC", rules: null };

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
    lastContactAt: null,
    nextFollowUpDate: null,
    isOutreachCandidate: false,
    lastOrderAnywhere: null,
    ...over,
  };
}

describe("parseClientBookOptions", () => {
  it("defaults everything", () => {
    expect(parseClientBookOptions({})).toEqual({
      search: "",
      lastOrder: "all",
      notes: "all",
      followUp: "all",
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
        followUp: "all",
        sort: "spend",
        page: "3",
      }),
    ).toEqual({
      search: "summer home",
      lastOrder: "over2y",
      notes: "withNotes",
      followUp: "all",
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
    filterClientBook(all, { lastOrder, notes: "all", followUp: "all" }, context);

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
      filterClientBook([sixMonthsToTheDay], { lastOrder, notes: "all", followUp: "all" }, context);
    expect(inBand("within6m")).toHaveLength(1);
    expect(inBand("6to12m")).toHaveLength(0);
  });

  it("filters on whether notes exist", () => {
    const noted = entry({ hasNotes: true });
    const silent = entry({ hasNotes: false });
    expect(
      filterClientBook(
        [noted, silent],
        { lastOrder: "all", notes: "withNotes", followUp: "all" },
        context,
      ),
    ).toEqual([noted]);
    expect(
      filterClientBook(
        [noted, silent],
        { lastOrder: "all", notes: "withoutNotes", followUp: "all" },
        context,
      ),
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

describe("who a store has asked to be reminded of", () => {
  it("suggests no one until a store sets a lifetime spend", () => {
    const off = { outreachMinLifetimeSpend: null, outreachLapsedMonths: 6, outreachQuietDays: 10 };
    expect(readOutreachRules(off)).toBeNull();
  });

  it("uses the store's numbers, and the defaults where it left them empty", () => {
    expect(
      readOutreachRules({
        outreachMinLifetimeSpend: 800,
        outreachLapsedMonths: 6,
        outreachQuietDays: 10,
      }),
    ).toEqual({ minLifetimeSpend: 800, lapsedMonths: 6, quietDays: 10 });
    expect(
      readOutreachRules({
        outreachMinLifetimeSpend: 800,
        outreachLapsedMonths: null,
        outreachQuietDays: null,
      }),
    ).toEqual({
      minLifetimeSpend: 800,
      lapsedMonths: DEFAULT_OUTREACH_LAPSED_MONTHS,
      quietDays: DEFAULT_OUTREACH_QUIET_DAYS,
    });
  });
});

describe("isSuggestedOutreach", () => {
  const rules = { minLifetimeSpend: 1000, lapsedMonths: 12, quietDays: 90 };
  const asked = { now, timeZone: "UTC", rules };
  const drifted = entry({
    lifetimeSpend: 1000,
    isOutreachCandidate: true,
    lastOrderAnywhere: new Date("2025-10-01T00:00:00.000Z"),
    lastContactAt: new Date("2026-07-01T00:00:00.000Z"),
  });

  it("suggests a big client who has gone quiet", () => {
    expect(isSuggestedOutreach(drifted, asked)).toBe(true);
    expect(isSuggestedOutreach({ ...drifted, lastContactAt: null }, asked)).toBe(true);
  });

  it("suggests no one when the store hasn't asked", () => {
    expect(isSuggestedOutreach(drifted, { ...asked, rules: null })).toBe(false);
  });

  it.each([
    ["isn't this person's to work", { isOutreachCandidate: false }],
    ["has spent less", { lifetimeSpend: 999.99 }],
    ["has an open quote", { openQuotes: 1 }],
    ["has never ordered", { lastOrderAnywhere: null }],
    ["ordered too recently", { lastOrderAnywhere: new Date("2025-12-01T00:00:00.000Z") }],
    ["was contacted too recently", { lastContactAt: new Date("2026-09-01T00:00:00.000Z") }],
    ["has a follow-up coming", { nextFollowUpDate: "2026-11-20" }],
    ["has a follow-up due", { nextFollowUpDate: "2026-11-04" }],
  ])("leaves out a client who %s", (_why, over) => {
    expect(isSuggestedOutreach({ ...drifted, ...over }, asked)).toBe(false);
  });

  it("goes by the store's own numbers", () => {
    const stricter = { ...asked, rules: { ...rules, lapsedMonths: 24 } };
    expect(isSuggestedOutreach(drifted, stricter)).toBe(false);
    const quieter = { ...asked, rules: { ...rules, quietDays: 200 } };
    expect(isSuggestedOutreach(drifted, quieter)).toBe(false);
  });
});

describe("the follow-up views", () => {
  const options = { lastOrder: "all", notes: "all" } as const;
  const due = entry({ customerId: 1, nextFollowUpDate: "2026-11-04" });
  const coming = entry({ customerId: 2, nextFollowUpDate: "2026-11-05" });
  const handled = entry({
    customerId: 3,
    nextFollowUpDate: "2026-11-03",
    lastContactAt: new Date("2026-11-03T18:00:00.000Z"),
  });
  const none = entry({ customerId: 4 });
  const ids = (view: "all" | "due" | "scheduled", timeZone = "UTC") =>
    filterClientBook(
      [due, coming, handled, none],
      { ...options, followUp: view },
      { ...context, timeZone },
    ).map((row) => row.customerId);

  it("lists who's due and who's scheduled, and all of them for All", () => {
    expect(ids("due")).toEqual([1]);
    expect(ids("scheduled")).toEqual([2]);
    expect(ids("all")).toEqual([1, 2, 3, 4]);
  });

  it("reads today by the store's clock", () => {
    // 12:00 UTC on the 4th is already the 5th in Kiritimati, so the 5th has arrived.
    expect(ids("due", "Pacific/Kiritimati")).toEqual([1, 2]);
  });

  it("reads the day of a contact by the store's clock too", () => {
    // 3am UTC on the 4th is the evening of the 3rd in New York, before the date, so it's
    // still due there. In a UTC store the same call was on the date.
    const called = entry({
      customerId: 5,
      nextFollowUpDate: "2026-11-04",
      lastContactAt: new Date("2026-11-04T03:00:00.000Z"),
    });
    const dueIn = (timeZone: string) =>
      filterClientBook([called], { ...options, followUp: "due" }, { ...context, timeZone });
    expect(dueIn("America/New_York")).toHaveLength(1);
    expect(dueIn("UTC")).toHaveLength(0);
  });

  it("reads an unknown view as All", () => {
    expect(parseClientBookOptions({ followUp: "nonsense" }).followUp).toBe("all");
    expect(parseClientBookOptions({ followUp: "suggested" }).followUp).toBe("suggested");
  });
});

describe("the follow-up sorts", () => {
  const named = (firstName: string, over: Partial<ClientBookEntry>) =>
    entry({ firstName, lastName: "Sort", ...over });
  const names = (rows: ClientBookEntry[]) => rows.map((row) => row.firstName);

  it("puts whoever has waited longest first, and never contacted before that", () => {
    const rows = [
      named("Recent", { lastContactAt: new Date("2026-10-01T00:00:00.000Z") }),
      named("Never", { lastContactAt: null }),
      named("Older", { lastContactAt: new Date("2026-01-01T00:00:00.000Z") }),
    ];
    expect(names(sortClientBook(rows, "lastContact"))).toEqual(["Never", "Older", "Recent"]);
  });

  it("puts the soonest date first, and no date last", () => {
    const rows = [
      named("None", { nextFollowUpDate: null }),
      named("Later", { nextFollowUpDate: "2026-12-01" }),
      named("Soon", { nextFollowUpDate: "2026-11-05" }),
    ];
    expect(names(sortClientBook(rows, "nextFollowUp"))).toEqual(["Soon", "Later", "None"]);
  });
});

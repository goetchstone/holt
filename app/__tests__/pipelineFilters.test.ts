// /app/__tests__/pipelineFilters.test.ts
//
// The pipeline's filters, sorts and the note match shown when a search hits an
// older note. Boundary values come from the bands documented in pipelineFilters.ts.

import { EMPTY_CLIENT_PROFILE, readClientProfileChoices } from "@/lib/clientProfile";
import type { FollowUpState } from "@/lib/pipelineFollowUp";
import {
  countActiveFilters,
  DEFAULT_PIPELINE_FILTERS,
  FOLLOW_UP_FILTERS,
  filterPipelineQuotes,
  findMatchingNote,
  sortPipelineQuotes,
  profileFilters,
  storeFilterOptions,
  valueFilters,
  type FilterableQuote,
} from "@/lib/pipelineFilters";

type QuoteProfile = NonNullable<NonNullable<FilterableQuote["customer"]>["profile"]>;

const profile: QuoteProfile = EMPTY_CLIENT_PROFILE;

function quote(over: Partial<FilterableQuote> = {}): FilterableQuote {
  return {
    storeLocation: "Mill",
    totalAmount: 1000,
    followUpState: "current",
    lastInteractionAt: "2026-11-01T00:00:00.000Z",
    isPlaceholderQuote: false,
    daysSinceContact: 3,
    daysSinceCreated: 10,
    customer: {
      leadTier: "WARM",
      history: { orderCount: 0, lastPurchase: null },
      profile: null,
    },
    interactions: [],
    ...over,
  };
}

function withProfile(over: Partial<QuoteProfile>): FilterableQuote {
  return quote({
    customer: {
      leadTier: "WARM",
      history: { orderCount: 0, lastPurchase: null },
      profile: { ...profile, ...over },
    },
  });
}

const TODAY = "2026-11-05";

function shown(quotes: FilterableQuote[], filters: Partial<typeof DEFAULT_PIPELINE_FILTERS>) {
  return filterPipelineQuotes(quotes, { ...DEFAULT_PIPELINE_FILTERS, ...filters }, TODAY);
}

describe("filterPipelineQuotes", () => {
  it("shows everything by default", () => {
    const quotes = [quote(), quote({ customer: null })];
    expect(shown(quotes, {})).toHaveLength(2);
  });

  it("filters follow-up by overdue or due, scheduled, and no contact yet", () => {
    const overdue = quote({ followUpState: "overdue" });
    const due = quote({ followUpState: "due" });
    const scheduled = quote({ followUpState: "scheduled" });
    const untouched = quote({ lastInteractionAt: null });
    const all = [overdue, due, scheduled, untouched];
    expect(shown(all, { followUp: "attention" })).toEqual([overdue, due]);
    expect(shown(all, { followUp: "scheduled" })).toEqual([scheduled]);
    expect(shown(all, { followUp: "noContact" })).toEqual([untouched]);
  });

  it("filters by store and lead tier", () => {
    const dock = quote({ storeLocation: "Dock" });
    const noStore = quote({ storeLocation: null });
    const hot = quote({ customer: { leadTier: "HOT", history: null, profile: null } });
    expect(shown([dock, noStore], { store: "Dock" })).toEqual([dock]);
    expect(shown([quote(), hot], { tier: "HOT" })).toEqual([hot]);
  });

  it("splits past from new clients and leaves the Cash Sale placeholder out of both", () => {
    const clientWith = (history: { orderCount: number; lastPurchase: unknown | null } | null) =>
      quote({ customer: { leadTier: "NEW", history, profile: null } });
    const past = clientWith({ orderCount: 2, lastPurchase: null });
    const justBought = clientWith({ orderCount: 0, lastPurchase: { id: 1 } });
    const fresh = clientWith({ orderCount: 0, lastPurchase: null });
    const cashSale = clientWith(null);
    const all = [past, justBought, fresh, cashSale];
    expect(shown(all, { client: "past" })).toEqual([past, justBought]);
    expect(shown(all, { client: "new" })).toEqual([fresh]);
  });

  it("puts each value boundary in the higher band", () => {
    const at = (totalAmount: number) => quote({ totalAmount });
    const all = [at(0), at(2499.99), at(2500), at(9999.99), at(10000)];
    const amounts = (value: string) => shown(all, { value }).map((q) => q.totalAmount);
    expect(amounts("under2500")).toEqual([0, 2499.99]);
    expect(amounts("2500to10000")).toEqual([2500, 9999.99]);
    expect(amounts("over10000")).toEqual([10000]);
  });

  it("filters itemized from placeholder quotes", () => {
    const placeholder = quote({ isPlaceholderQuote: true });
    const itemized = quote();
    expect(shown([placeholder, itemized], { quoteType: "placeholder" })).toEqual([placeholder]);
    expect(shown([placeholder, itemized], { quoteType: "itemized" })).toEqual([itemized]);
  });

  it("filters on the client's info and hides clients with none on file", () => {
    const vacation = withProfile({
      residenceType: "Secondary/Vacation",
      projectTimeline: "1-3 months",
      roomsOfInterest: ["Living Room", "Rugs"],
    });
    const nothingOnFile = quote();
    const all = [vacation, nothingOnFile];
    expect(shown(all, { residence: "Secondary/Vacation" })).toEqual([vacation]);
    expect(shown(all, { timeline: "1-3 months" })).toEqual([vacation]);
    expect(shown(all, { room: "Rugs" })).toEqual([vacation]);
    expect(shown(all, { room: "Office" })).toEqual([]);
  });

  it("puts closing odds in bands, with a client who has none in no band", () => {
    const at = (closeLikelihood: number | null) => withProfile({ closeLikelihood });
    const all = [at(4), at(5), at(7), at(8), at(null)];
    const odds = (filter: string) =>
      shown(all, { odds: filter }).map((q) => q.customer?.profile?.closeLikelihood);
    expect(odds("unlikely")).toEqual([4]);
    expect(odds("possible")).toEqual([5, 7]);
    expect(odds("likely")).toEqual([8]);
  });
});

describe("sortPipelineQuotes", () => {
  const low = quote({ totalAmount: 100, daysSinceContact: 2 });
  const high = quote({ totalAmount: 900, daysSinceContact: null, daysSinceCreated: 30 });

  it("keeps the API's newest-first order by default", () => {
    expect(sortPipelineQuotes([low, high], "newest")).toEqual([low, high]);
  });

  it("sorts by value and by days waiting", () => {
    expect(sortPipelineQuotes([low, high], "value")).toEqual([high, low]);
    expect(sortPipelineQuotes([low, high], "waiting")).toEqual([high, low]);
  });

  it("sorts soonest follow-up first with undated quotes last", () => {
    const soon = withProfile({ nextFollowUpDate: "2026-11-05" });
    const later = withProfile({ nextFollowUpDate: "2026-12-05" });
    const undated = quote();
    expect(sortPipelineQuotes([undated, later, soon], "nextFollowUp")).toEqual([
      soon,
      later,
      undated,
    ]);
  });

  it("sorts best odds first with unknown odds last", () => {
    const likely = withProfile({ closeLikelihood: 9 });
    const unknown = quote();
    expect(sortPipelineQuotes([unknown, likely], "odds")).toEqual([likely, unknown]);
  });

  it("doesn't reorder the list it was given", () => {
    const input = [low, high];
    sortPipelineQuotes(input, "value");
    expect(input).toEqual([low, high]);
  });
});

describe("countActiveFilters", () => {
  it("counts filters but not the sort", () => {
    expect(countActiveFilters(DEFAULT_PIPELINE_FILTERS)).toBe(0);
    expect(countActiveFilters({ ...DEFAULT_PIPELINE_FILTERS, sort: "value" })).toBe(0);
    expect(countActiveFilters({ ...DEFAULT_PIPELINE_FILTERS, tier: "HOT", room: "Office" })).toBe(
      2,
    );
  });
});

describe("storeFilterOptions", () => {
  it("lists each store once, sorted, after All stores", () => {
    const values = storeFilterOptions(["Mill", null, "Dock", "Dock"], "all").map((o) => o.value);
    expect(values).toEqual(["all", "Dock", "Mill"]);
  });

  it("keeps a saved store selectable when the current view has none of its quotes", () => {
    const values = storeFilterOptions(["Mill"], "Old Harbor").map((o) => o.value);
    expect(values).toContain("Old Harbor");
  });
});

describe("findMatchingNote", () => {
  const note = (notes: string | null) => ({ notes });

  it("finds an older note, ignoring case", () => {
    const q = quote({
      interactions: [note("Left a voicemail"), note("Buying for their Summer Home in Lakeside")],
    });
    expect(findMatchingNote(q, "summer home")).toBe("Buying for their Summer Home in Lakeside");
  });

  it("prefers a note holding every word over one holding some", () => {
    const q = quote({
      interactions: [note("Home office first"), note("Summer home in Lakeside")],
    });
    expect(findMatchingNote(q, "summer home")).toBe("Summer home in Lakeside");
  });

  it("finds the project description too", () => {
    const q = withProfile({ projectDescription: "Lake house refresh" });
    expect(findMatchingNote(q, "lake")).toBe("Lake house refresh");
  });

  it("finds keywords and homes, so a search for a summer home always shows why", () => {
    const byKeyword = withProfile({ keywords: ["Pets and kids"] });
    expect(findMatchingNote(byKeyword, "pets")).toBe("Pets and kids");
    const byHome = withProfile({ homes: "Summer beach house in Lakeside" });
    expect(findMatchingNote(byHome, "summer")).toBe("Summer beach house in Lakeside");
  });

  it("returns nothing for a blank search or a match only on the name", () => {
    const q = quote({ interactions: [note("Left a voicemail")] });
    expect(findMatchingNote(q, "   ")).toBeNull();
    expect(findMatchingNote(q, "smith")).toBeNull();
  });
});

describe("filters from a store's own lists", () => {
  it("offers what the store set, with an all option first", () => {
    const options = profileFilters(
      readClientProfileChoices({ timelines: ["Soon"], rooms: ["Den"], residences: ["Cabin"] }),
    );
    expect(options.timeline.map((o) => o.value)).toEqual(["all", "Soon"]);
    expect(options.room.map((o) => o.value)).toEqual(["all", "Den"]);
    expect(options.residence.map((o) => o.value)).toEqual(["all", "Cabin"]);
  });

  it("words the value bands in the store's currency", () => {
    const labels = valueFilters((n) => `£${n}`).map((o) => o.label);
    expect(labels).toEqual(["Any value", "Under £2500", "£2500 to £10000", "£10000 and up"]);
  });
});

describe("the follow-up filters", () => {
  const today = "2026-11-05";
  const withDate = (followUpState: FollowUpState, nextFollowUpDate: string | null) =>
    quote({
      followUpState,
      customer: {
        leadTier: null,
        history: null,
        profile: { ...EMPTY_CLIENT_PROFILE, nextFollowUpDate },
      },
    });
  const due = withDate("due", "2026-11-05");
  const overdue = withDate("overdue", null);
  const inAWeek = withDate("scheduled", "2026-11-12");
  const nextMonth = withDate("scheduled", "2026-12-12");
  const all = [due, overdue, inAWeek, nextMonth];
  const pick = (followUp: string) =>
    filterPipelineQuotes(all, { ...DEFAULT_PIPELINE_FILTERS, followUp }, today);

  it("tells a date that has arrived from a quote left too long", () => {
    expect(pick("due")).toEqual([due]);
    expect(pick("overdue")).toEqual([overdue]);
    expect(pick("attention")).toEqual([due, overdue]);
  });

  it("counts the next seven days, up to and including the seventh", () => {
    expect(pick("dueSoon")).toEqual([inAWeek]);
    expect(pick("scheduled")).toEqual([inAWeek, nextMonth]);
  });

  it("offers each of them", () => {
    expect(FOLLOW_UP_FILTERS.map((option) => option.value)).toEqual(
      expect.arrayContaining(["due", "overdue", "dueSoon", "scheduled"]),
    );
  });
});

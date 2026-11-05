// /app/__tests__/clientProfile.test.ts
//
// The Client Info form's server-side validation: a bad choice must come back as a
// readable 400, and empty fields must save as empty rather than as "" or undefined.

import {
  clientInfoTexts,
  EMPTY_CLIENT_PROFILE,
  fillProfileGaps,
  hasClientInfo,
  parseClientProfileBody,
  toClientProfileView,
  DEFAULT_CLIENT_PROFILE_CHOICES,
  MAX_CHOICE_LENGTH,
  MAX_CHOICES_PER_LIST,
  parseClientProfileChoices,
  readClientProfileChoices,
  withSavedAnswer,
} from "@/lib/clientProfile";

describe("parseClientProfileBody", () => {
  it("accepts a filled-in form and converts its dates for a date column", () => {
    const parsed = parseClientProfileBody({
      projectDescription: "  Summer home living room  ",
      roomsOfInterest: ["Living Room", "Rugs"],
      residenceType: "Secondary/Vacation",
      projectTimeline: "1-3 months",
      budgetRange: "10K-25K",
      decisionMaker: "With spouse or partner",
      closeLikelihood: 8,
      expectedCloseDate: "2026-12-01",
      nextSteps: ["Schedule house call"],
      nextFollowUpDate: "2026-11-15",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.projectDescription).toBe("Summer home living room");
    expect(parsed.data.roomsOfInterest).toEqual(["Living Room", "Rugs"]);
    expect(parsed.data.closeLikelihood).toBe(8);
    expect(parsed.data.expectedCloseDate?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(parsed.data.nextFollowUpDate?.toISOString()).toBe("2026-11-15T00:00:00.000Z");
  });

  it("saves a missing or blank field as empty", () => {
    const parsed = parseClientProfileBody({ projectDescription: "   ", residenceType: "" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toEqual({
      ...EMPTY_CLIENT_PROFILE,
      expectedCloseDate: null,
      nextFollowUpDate: null,
      searchText: null,
    });
  });

  it("drops repeated choices", () => {
    const parsed = parseClientProfileBody({ roomsOfInterest: ["Office", "Office"] });
    expect(parsed.ok && parsed.data.roomsOfInterest).toEqual(["Office"]);
  });

  it.each([
    [{ residenceType: "Boat" }, "residenceType"],
    [{ budgetRange: "Huge" }, "budgetRange"],
    [{ roomsOfInterest: ["Garage"] }, "roomsOfInterest"],
    [{ roomsOfInterest: "Office" }, "roomsOfInterest"],
    [{ nextSteps: ["Call the mayor"] }, "nextSteps"],
    [{ closeLikelihood: 0 }, "closeLikelihood"],
    [{ closeLikelihood: 11 }, "closeLikelihood"],
    [{ closeLikelihood: 7.5 }, "closeLikelihood"],
    [{ expectedCloseDate: "next week" }, "expectedCloseDate"],
    [{ nextFollowUpDate: "2026-02-30" }, "nextFollowUpDate"],
    [{ projectDescription: 12 }, "projectDescription"],
  ])("rejects %j and names the field", (body, field) => {
    const parsed = parseClientProfileBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(field);
  });
});

describe("keywords", () => {
  it("trims them and drops blanks and repeats, ignoring case", () => {
    const parsed = parseClientProfileBody({
      keywords: [" Pets and kids ", "pets AND kids", "", "Boat house"],
    });
    expect(parsed.ok && parsed.data.keywords).toEqual(["Pets and kids", "Boat house"]);
  });

  it("rejects anything that isn't a short list of text", () => {
    expect(parseClientProfileBody({ keywords: "pets" }).ok).toBe(false);
    expect(parseClientProfileBody({ keywords: [5] }).ok).toBe(false);
    expect(parseClientProfileBody({ keywords: ["x".repeat(61)] }).ok).toBe(false);
    const tooMany = Array.from({ length: 21 }, (_, i) => `keyword ${i}`);
    expect(parseClientProfileBody({ keywords: tooMany }).ok).toBe(false);
  });
});

describe("searchText", () => {
  it("holds everything a designer might search for", () => {
    const parsed = parseClientProfileBody({
      projectDescription: "Family room refresh",
      stylePreferences: "Warm neutrals",
      homes: "Summer beach house in Lakeside",
      preferredBrands: "Heron & Wren",
      keywords: ["Pets and kids"],
      roomsOfInterest: ["Outdoor"],
      residenceType: "Secondary/Vacation",
      nextSteps: ["Quoting"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const term of [
      "Family room",
      "Warm neutrals",
      "beach house",
      "Heron & Wren",
      "Pets and kids",
      "Outdoor",
      "Vacation",
      "Quoting",
    ]) {
      expect(parsed.data.searchText).toContain(term);
    }
  });

  it("is empty when there's nothing to search", () => {
    const parsed = parseClientProfileBody({ nextFollowUpDate: "2026-12-01" });
    expect(parsed.ok && parsed.data.searchText).toBeNull();
  });
});

describe("clientInfoTexts", () => {
  it("lists only what's filled in", () => {
    expect(clientInfoTexts(null)).toEqual([]);
    expect(clientInfoTexts(EMPTY_CLIENT_PROFILE)).toEqual([]);
    expect(
      clientInfoTexts({ ...EMPTY_CLIENT_PROFILE, homes: "Beach house", keywords: ["Pets"] }),
    ).toEqual(["Beach house", "Pets"]);
  });
});

describe("hasClientInfo", () => {
  it("is false with no profile and for a profile holding only a follow-up date", () => {
    expect(hasClientInfo(null)).toBe(false);
    expect(hasClientInfo({ ...EMPTY_CLIENT_PROFILE, nextFollowUpDate: "2026-11-15" })).toBe(false);
  });

  it("is true once anything else is recorded", () => {
    expect(hasClientInfo({ ...EMPTY_CLIENT_PROFILE, closeLikelihood: 1 })).toBe(true);
    expect(hasClientInfo({ ...EMPTY_CLIENT_PROFILE, roomsOfInterest: ["Office"] })).toBe(true);
  });
});

describe("fillProfileGaps", () => {
  const empty = {
    ...EMPTY_CLIENT_PROFILE,
    expectedCloseDate: null,
    nextFollowUpDate: null,
    searchText: null,
  };
  const date = new Date("2026-12-01T00:00:00.000Z");

  it("fills a date-only profile from a duplicate's completed form", () => {
    const kept = { ...empty, nextFollowUpDate: date };
    const other = { ...empty, budgetRange: "Open", roomsOfInterest: ["Office"] };
    expect(fillProfileGaps(kept, other)).toEqual({
      ...other,
      nextFollowUpDate: date,
      searchText: "Office\nOpen",
    });
  });

  it("keeps the surviving profile's own answers", () => {
    const kept = { ...empty, budgetRange: "$25K+", closeLikelihood: 2, nextSteps: ["Quoting"] };
    const other = { ...empty, budgetRange: "Open", closeLikelihood: 9, nextSteps: ["Quoting"] };
    expect(fillProfileGaps(kept, other)).toEqual({ ...kept, searchText: "$25K+\nQuoting" });
  });
});

describe("toClientProfileView", () => {
  it("turns date columns back into the same calendar dates", () => {
    const view = toClientProfileView({
      ...EMPTY_CLIENT_PROFILE,
      expectedCloseDate: new Date("2026-12-01T00:00:00.000Z"),
      nextFollowUpDate: null,
      searchText: null,
    });
    expect(view.expectedCloseDate).toBe("2026-12-01");
    expect(view.nextFollowUpDate).toBeNull();
  });
});

describe("a store's own choices", () => {
  it("uses the suggestions until a store sets its own, list by list", () => {
    expect(readClientProfileChoices(null)).toEqual(DEFAULT_CLIENT_PROFILE_CHOICES);
    const own = readClientProfileChoices({ budgets: ["Small", "Large"] });
    expect(own.budgets).toEqual(["Small", "Large"]);
    expect(own.rooms).toEqual(DEFAULT_CLIENT_PROFILE_CHOICES.rooms);
  });

  it("ignores a stored list that isn't a list of text", () => {
    expect(readClientProfileChoices({ rooms: "Kitchen" }).rooms).toEqual(
      DEFAULT_CLIENT_PROFILE_CHOICES.rooms,
    );
    expect(readClientProfileChoices({ rooms: [1, 2] }).rooms).toEqual(
      DEFAULT_CLIENT_PROFILE_CHOICES.rooms,
    );
  });

  it("cleans up what Settings sends: trims, drops blanks and repeats", () => {
    const parsed = parseClientProfileChoices({ rooms: [" Den ", "", "den", "Sunroom"] });
    expect(parsed.ok && parsed.choices.rooms).toEqual(["Den", "Sunroom"]);
  });

  it("lets a store empty a list, which takes that field off the form", () => {
    const parsed = parseClientProfileChoices({ budgets: [] });
    expect(parsed.ok && parsed.choices.budgets).toEqual([]);
  });

  it("refuses a list that isn't text, too long, or an entry too long, naming the list", () => {
    expect(parseClientProfileChoices({ rooms: "Den" })).toEqual({
      ok: false,
      error: expect.stringMatching(/Rooms of interest/),
    });
    expect(parseClientProfileChoices({ rooms: [5] }).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_CHOICES_PER_LIST + 1 }, (_, i) => `Room ${i}`);
    expect(parseClientProfileChoices({ budgets: tooMany })).toEqual({
      ok: false,
      error: expect.stringMatching(/Budget ranges/),
    });
    expect(parseClientProfileChoices({ nextSteps: ["x".repeat(MAX_CHOICE_LENGTH + 1)] }).ok).toBe(
      false,
    );
  });

  it("checks answers against this store's lists", () => {
    const choices = readClientProfileChoices({ budgets: ["Small"], rooms: ["Den"] });
    expect(
      parseClientProfileBody({ budgetRange: "Small", roomsOfInterest: ["Den"] }, choices).ok,
    ).toBe(true);
    expect(parseClientProfileBody({ budgetRange: "10K-25K" }, choices).ok).toBe(false);
    expect(parseClientProfileBody({ roomsOfInterest: ["Office"] }, choices).ok).toBe(false);
  });

  it("keeps an answer already on the client after its choice is removed", () => {
    const choices = readClientProfileChoices({ budgets: ["Small"], rooms: ["Den"] });
    const current = {
      roomsOfInterest: ["Office"],
      residenceType: null,
      projectTimeline: null,
      budgetRange: "10K-25K",
      decisionMaker: null,
      nextSteps: [],
    };
    const kept = parseClientProfileBody(
      { budgetRange: "10K-25K", roomsOfInterest: ["Office", "Den"] },
      choices,
      current,
    );
    expect(kept.ok).toBe(true);
    const other = parseClientProfileBody({ budgetRange: "25K+" }, choices, current);
    expect(other.ok).toBe(false);
  });
});

describe("withSavedAnswer", () => {
  it("adds what's saved to the list, once, for one answer or several", () => {
    expect(withSavedAnswer(["A", "B"], "C")).toEqual(["A", "B", "C"]);
    expect(withSavedAnswer(["A", "B"], "A")).toEqual(["A", "B"]);
    expect(withSavedAnswer(["A"], ["B", "A", "C"])).toEqual(["A", "B", "C"]);
  });

  it("is just the list when nothing is saved", () => {
    expect(withSavedAnswer(["A"], null)).toEqual(["A"]);
    expect(withSavedAnswer(["A"], undefined)).toEqual(["A"]);
    expect(withSavedAnswer(["A"], [])).toEqual(["A"]);
  });
});

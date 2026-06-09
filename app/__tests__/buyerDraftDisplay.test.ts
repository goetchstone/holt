// /app/__tests__/buyerDraftDisplay.test.ts
//
// A-grade tests for the draft-vs-linked-Product display fallback helper.

import {
  resolveDraftDisplay,
  type DraftItemDisplayInput,
  type LinkedProductDisplayInput,
} from "@/lib/buyerDraftDisplay";

const blankDraft: DraftItemDisplayInput = {
  description: null,
  cost: "0",
  retail: "0",
  msrp: null,
  productWidth: null,
  productLength: null,
  productHeight: null,
};

const fullDraft: DraftItemDisplayInput = {
  description: "Buyer-typed description",
  cost: "1275",
  retail: "3039",
  msrp: "4050",
  productWidth: "30",
  productLength: "39.5",
  productHeight: "34",
};

const richLink: LinkedProductDisplayInput = {
  description: "Catalog Murphey Swivel Chair description",
  baseCost: { toString: () => "1100" },
  baseRetail: { toString: () => "2750" },
  mapPrice: { toString: () => "3850" },
  width: 32,
  depth: 40,
  height: 35,
};

const emptyLink: LinkedProductDisplayInput = {
  description: null,
  baseCost: null,
  baseRetail: null,
  mapPrice: null,
  width: null,
  depth: null,
  height: null,
};

describe("resolveDraftDisplay — description fallback", () => {
  it("uses draft description when present", () => {
    const r = resolveDraftDisplay(fullDraft, richLink);
    expect(r.description).toBe("Buyer-typed description");
    expect(r.source.description).toBe("draft");
  });

  it("falls back to linked Product description when draft is blank", () => {
    const r = resolveDraftDisplay(blankDraft, richLink);
    expect(r.description).toBe("Catalog Murphey Swivel Chair description");
    expect(r.source.description).toBe("linked");
  });

  it("returns null when both draft and linked are blank", () => {
    const r = resolveDraftDisplay(blankDraft, emptyLink);
    expect(r.description).toBeNull();
    expect(r.source.description).toBeUndefined();
  });

  it("returns null when no linked Product and draft is blank", () => {
    const r = resolveDraftDisplay(blankDraft, null);
    expect(r.description).toBeNull();
  });

  it("treats whitespace-only draft description as blank", () => {
    const r = resolveDraftDisplay({ ...fullDraft, description: "   " }, richLink);
    expect(r.description).toBe("Catalog Murphey Swivel Chair description");
    expect(r.source.description).toBe("linked");
  });
});

describe("resolveDraftDisplay — cost/retail fallback", () => {
  it("uses draft cost when non-zero", () => {
    const r = resolveDraftDisplay(fullDraft, richLink);
    expect(r.cost).toBe("1275");
    expect(r.source.cost).toBe("draft");
  });

  it("falls back to linked baseCost when draft cost is 0", () => {
    const r = resolveDraftDisplay(blankDraft, richLink);
    expect(r.cost).toBe("1100");
    expect(r.source.cost).toBe("linked");
  });

  it("uses draft retail when non-zero", () => {
    const r = resolveDraftDisplay(fullDraft, richLink);
    expect(r.retail).toBe("3039");
    expect(r.source.retail).toBe("draft");
  });

  it("falls back to linked baseRetail when draft retail is 0", () => {
    const r = resolveDraftDisplay(blankDraft, richLink);
    expect(r.retail).toBe("2750");
    expect(r.source.retail).toBe("linked");
  });

  it("returns 0 when both draft and linked are zero/null", () => {
    const r = resolveDraftDisplay(blankDraft, emptyLink);
    expect(r.cost).toBe("0");
    expect(r.retail).toBe("0");
  });
});

describe("resolveDraftDisplay — msrp fallback", () => {
  it("uses draft msrp when present", () => {
    const r = resolveDraftDisplay(fullDraft, richLink);
    expect(r.msrp).toBe("4050");
    expect(r.source.msrp).toBe("draft");
  });

  it("falls back to linked mapPrice when draft msrp is null", () => {
    const r = resolveDraftDisplay({ ...fullDraft, msrp: null }, richLink);
    expect(r.msrp).toBe("3850");
    expect(r.source.msrp).toBe("linked");
  });

  it("returns null when neither has a value", () => {
    const r = resolveDraftDisplay({ ...fullDraft, msrp: null }, emptyLink);
    expect(r.msrp).toBeNull();
  });
});

describe("resolveDraftDisplay — dimensions fallback", () => {
  it("uses draft dimensions when set", () => {
    const r = resolveDraftDisplay(fullDraft, richLink);
    expect(r.productWidth).toBe("30");
    expect(r.productLength).toBe("39.5");
    expect(r.productHeight).toBe("34");
    expect(r.source.productWidth).toBe("draft");
  });

  it("falls back to linked Product dimensions when draft is blank", () => {
    const r = resolveDraftDisplay(blankDraft, richLink);
    expect(r.productWidth).toBe("32");
    expect(r.productLength).toBe("40"); // linked.depth → productLength
    expect(r.productHeight).toBe("35");
    expect(r.source.productWidth).toBe("linked");
  });

  it("returns null for each dimension when both draft + linked are null", () => {
    const r = resolveDraftDisplay(blankDraft, emptyLink);
    expect(r.productWidth).toBeNull();
    expect(r.productLength).toBeNull();
    expect(r.productHeight).toBeNull();
  });

  it("mixed: draft has width, linked has depth + height", () => {
    const r = resolveDraftDisplay({ ...blankDraft, productWidth: "28" }, richLink);
    expect(r.productWidth).toBe("28");
    expect(r.source.productWidth).toBe("draft");
    expect(r.productLength).toBe("40");
    expect(r.source.productLength).toBe("linked");
    expect(r.productHeight).toBe("35");
    expect(r.source.productHeight).toBe("linked");
  });
});

describe("resolveDraftDisplay — no linked Product at all", () => {
  it("returns draft values verbatim when linked is null", () => {
    const r = resolveDraftDisplay(fullDraft, null);
    expect(r.description).toBe("Buyer-typed description");
    expect(r.cost).toBe("1275");
    expect(r.retail).toBe("3039");
    expect(r.msrp).toBe("4050");
    expect(r.productWidth).toBe("30");
    expect(r.source).toEqual({
      description: "draft",
      cost: "draft",
      retail: "draft",
      msrp: "draft",
      productWidth: "draft",
      productLength: "draft",
      productHeight: "draft",
    });
  });
});

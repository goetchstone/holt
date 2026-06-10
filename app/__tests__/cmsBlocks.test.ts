// /app/__tests__/cmsBlocks.test.ts

import { BLOCK_TYPES, parseBlocks, createBlock, type ContentBlock } from "@/lib/cms/blocks";
import { parseMenuItems } from "@/lib/cms/menu";

describe("parseBlocks", () => {
  it("returns [] for null/undefined (unset Json column)", () => {
    expect(parseBlocks(null)).toEqual([]);
    expect(parseBlocks(undefined)).toEqual([]);
  });

  it("returns [] for non-array / malformed input", () => {
    expect(parseBlocks("nope")).toEqual([]);
    expect(parseBlocks({ not: "an array" })).toEqual([]);
  });

  it("fills schema defaults for a minimal block", () => {
    const blocks = parseBlocks([{ id: "b1", type: "hero" }]);
    expect(blocks).toHaveLength(1);
    const hero = blocks[0];
    expect(hero.type).toBe("hero");
    if (hero.type === "hero") {
      expect(hero.heading).toBe("");
      expect(hero.align).toBe("center");
    }
  });

  it("drops only invalid/unknown blocks, keeping the valid ones (render resilience)", () => {
    const out = parseBlocks([
      { id: "ok", type: "richText", html: "<p>hi</p>" },
      { id: "x", type: "bogus" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "ok", type: "richText" });
  });

  it("preserves authored values and order", () => {
    const input: ContentBlock[] = [
      { id: "1", type: "richText", html: "<p>hi</p>", background: "default" },
      { id: "2", type: "image", url: "/a.png", alt: "a", caption: "" },
    ];
    const out = parseBlocks(input);
    expect(out.map((b) => b.id)).toEqual(["1", "2"]);
    expect(out[0]).toMatchObject({ type: "richText", html: "<p>hi</p>" });
  });
});

describe("createBlock", () => {
  it("creates a valid default block for every registered type", () => {
    for (const type of BLOCK_TYPES) {
      const block = createBlock(type, `id-${type}`);
      expect(block.id).toBe(`id-${type}`);
      expect(block.type).toBe(type);
      // Round-trips through the parser (proves it satisfies the contract).
      expect(parseBlocks([block])).toHaveLength(1);
    }
  });
});

describe("section background + eyebrow variants", () => {
  it("uses the right default background per section block", () => {
    expect(createBlock("features", "f")).toMatchObject({ background: "default", eyebrow: "" });
    expect(createBlock("quote", "q")).toMatchObject({ background: "default", eyebrow: "" });
    expect(createBlock("cta", "c")).toMatchObject({ background: "muted", eyebrow: "" });
    expect(createBlock("stats", "s")).toMatchObject({ background: "dark" });
  });

  it("fills the background default when absent (back-compat with pre-variant content)", () => {
    const [feat] = parseBlocks([{ id: "f", type: "features", heading: "X" }]);
    if (feat.type === "features") expect(feat.background).toBe("default");
    const [stat] = parseBlocks([{ id: "s", type: "stats", items: [] }]);
    if (stat.type === "stats") expect(stat.background).toBe("dark");
  });

  it("preserves an authored background + eyebrow", () => {
    const [b] = parseBlocks([
      { id: "f", type: "features", background: "dark", eyebrow: "Why we exist" },
    ]);
    expect(b).toMatchObject({ background: "dark", eyebrow: "Why we exist" });
  });

  it("drops a block whose background is not a known variant (render resilience)", () => {
    const out = parseBlocks([
      { id: "ok", type: "features", background: "muted" },
      { id: "bad", type: "features", background: "rainbow" },
    ]);
    expect(out.map((b) => b.id)).toEqual(["ok"]);
  });
});

describe("parseMenuItems", () => {
  it("returns [] for null / malformed", () => {
    expect(parseMenuItems(null)).toEqual([]);
    expect(parseMenuItems(42)).toEqual([]);
  });

  it("parses items with nested children and fills defaults", () => {
    const items = parseMenuItems([
      { label: "Shop", href: "/shop", children: [{ label: "Sofas", href: "/shop/sofas" }] },
      { label: "About", href: "/about" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].children).toHaveLength(1);
    expect(items[1].children).toEqual([]);
  });
});

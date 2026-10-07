// /app/__tests__/leadMagnet.test.ts
//
// Pure tests for the lead-magnet intake helpers + the block contract: email
// normalization, source-tag sanitization (it lands in Lead.sourceDetail and
// must never carry user-controlled junk), and the leadMagnet CMS block
// parsing with defaults.

import { normalizeLeadEmail, leadMagnetSourceDetail } from "@/lib/leadMagnet";
import { parseBlocks, createBlock } from "@/lib/cms/blocks";

describe("normalizeLeadEmail", () => {
  it("trims + lowercases valid emails", () => {
    expect(normalizeLeadEmail("  Dana@Client.TEST ")).toBe("dana@client.test");
  });

  it.each(["", "   ", "nope", "a@b", "x".repeat(201) + "@a.com"])(
    "rejects invalid shapes (%j)",
    (input) => {
      expect(normalizeLeadEmail(input)).toBeNull();
    },
  );
});

describe("leadMagnetSourceDetail", () => {
  it("prefixes and sanitizes the tag", () => {
    expect(leadMagnetSourceDetail("DMARC-Guide")).toBe("lead-magnet:dmarc-guide");
    expect(leadMagnetSourceDetail("  weird <tag>!  ")).toBe("lead-magnet:weirdtag");
  });

  it("falls back to general for empty/garbage tags", () => {
    expect(leadMagnetSourceDetail("")).toBe("lead-magnet:general");
    expect(leadMagnetSourceDetail("<<<>>>")).toBe("lead-magnet:general");
  });

  it("caps the tag length", () => {
    const long = "a".repeat(100);
    expect(leadMagnetSourceDetail(long)).toBe(`lead-magnet:${"a".repeat(60)}`);
  });
});

describe("leadMagnet CMS block contract", () => {
  it("createBlock produces a valid default block", () => {
    const block = createBlock("leadMagnet", "b1");
    expect(block).toMatchObject({
      type: "leadMagnet",
      buttonLabel: "Get the guide",
      sourceTag: "general",
      background: "muted",
    });
  });

  it("parseBlocks accepts a stored leadMagnet block and drops corrupt ones", () => {
    const parsed = parseBlocks([
      {
        id: "b1",
        type: "leadMagnet",
        heading: "Free DMARC guide",
        resourceUrl: "/files/guide.pdf",
        sourceTag: "dmarc",
      },
      { id: "b2", type: "noSuchBlock" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: "leadMagnet", heading: "Free DMARC guide" });
  });
});

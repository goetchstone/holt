// /app/__tests__/cmsRequestBody.test.ts

import { parsePageInput, parsePostInput, parseMenuInput } from "@/lib/cms/requestBody";

describe("parsePageInput", () => {
  it("accepts a minimal valid page and applies defaults", () => {
    const out = parsePageInput({ title: "About", slug: "about" });
    expect(out).toMatchObject({ title: "About", slug: "about", status: "DRAFT", isHome: false });
    expect(out.blocks).toEqual([]);
  });

  it("requires a title", () => {
    // Missing title -> zod's type error; empty title -> our custom message.
    expect(() => parsePageInput({ slug: "x" })).toThrow();
    expect(() => parsePageInput({ title: "", slug: "x" })).toThrow(/title/i);
  });

  it("rejects a non-url-safe slug", () => {
    expect(() => parsePageInput({ title: "X", slug: "Not A Slug" })).toThrow(/slug/i);
    expect(() => parsePageInput({ title: "X", slug: "UPPER" })).toThrow(/slug/i);
  });

  it("allows nested slugs and validates blocks", () => {
    const out = parsePageInput({
      title: "Nested",
      slug: "company/about",
      status: "PUBLISHED",
      blocks: [{ id: "b1", type: "richText", html: "<p>hi</p>" }],
    });
    expect(out.slug).toBe("company/about");
    expect(out.status).toBe("PUBLISHED");
    expect(out.blocks).toHaveLength(1);
  });

  it("rejects an unknown block type", () => {
    expect(() =>
      parsePageInput({ title: "X", slug: "x", blocks: [{ id: "b", type: "nope" }] }),
    ).toThrow();
  });
});

describe("parsePostInput", () => {
  it("accepts a post and defaults tags to []", () => {
    const out = parsePostInput({ title: "Hello", slug: "hello" });
    expect(out).toMatchObject({ title: "Hello", slug: "hello", status: "DRAFT" });
    expect(out.tags).toEqual([]);
  });

  it("keeps provided optional fields", () => {
    const out = parsePostInput({
      title: "Hello",
      slug: "hello",
      excerpt: "intro",
      author: "Jo",
      tags: ["news"],
    });
    expect(out.excerpt).toBe("intro");
    expect(out.author).toBe("Jo");
    expect(out.tags).toEqual(["news"]);
  });
});

describe("parseMenuInput", () => {
  it("parses valid items", () => {
    const items = parseMenuInput({
      items: [{ label: "Home", href: "/", children: [] }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: "Home", href: "/" });
  });

  it("throws on a non-array items value", () => {
    expect(() => parseMenuInput({ items: "nope" })).toThrow(/menu/i);
  });
});

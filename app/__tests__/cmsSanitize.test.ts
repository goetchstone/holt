// /app/__tests__/cmsSanitize.test.ts

import { sanitizeCmsHtml } from "@/lib/cms/sanitize";

describe("sanitizeCmsHtml", () => {
  it("strips <script> tags", () => {
    const out = sanitizeCmsHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeCmsHtml('<img src="https://x/y.png" onerror="alert(1)" alt="">');
    expect(out).not.toContain("onerror");
  });

  it("drops javascript: hrefs but keeps safe links + forces rel", () => {
    expect(sanitizeCmsHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
    const safe = sanitizeCmsHtml('<a href="https://example.com">x</a>');
    expect(safe).toContain('href="https://example.com"');
    expect(safe).toContain('rel="noopener noreferrer"');
  });

  it("keeps allowed formatting tags", () => {
    const out = sanitizeCmsHtml(
      "<h2>Title</h2><p><strong>bold</strong> and <em>em</em></p><ul><li>a</li></ul>",
    );
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<li>a</li>");
  });

  it("allows iframes only from the provider allowlist", () => {
    const yt = sanitizeCmsHtml('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(yt).toContain("youtube.com/embed/abc");
    const evil = sanitizeCmsHtml('<iframe src="https://evil.example/x"></iframe>');
    expect(evil).not.toContain("evil.example");
  });

  it("handles empty/nullish input safely", () => {
    expect(sanitizeCmsHtml("")).toBe("");
    expect(sanitizeCmsHtml(undefined as unknown as string)).toBe("");
  });
});

// /app/__tests__/helpCatalog.test.ts
//
// The help center (GAP-30, DECISIONS 54). The articles are files and the list of them is
// code, so they can drift apart: this fails on an article with no file, a file with no
// entry, a screen that isn't a page, and a link to nothing (rule 65, both directions).
// It also keeps the screens with no article yet as a ratchet, so that number only falls.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_ACCESS } from "@/lib/auth/pagePermissions";
import {
  HELP_ARTICLES,
  helpArticle,
  helpForScreen,
  matchingArticles,
  screenMatches,
} from "@/lib/help/catalog";
import { HELP_DIR, renderHelpMarkdown } from "@/lib/help/articles";

const files = readdirSync(HELP_DIR).filter((f) => f.endsWith(".md"));
const source = (slug: string) => readFileSync(join(HELP_DIR, `${slug}.md`), "utf8");
const isPage = (route: string) => route in PAGE_ACCESS;

describe("the articles and their list", () => {
  it("gives every listed article a file", () => {
    for (const { slug } of HELP_ARTICLES) expect(files).toContain(`${slug}.md`);
  });

  it("lists every file", () => {
    const listed = HELP_ARTICLES.map((a) => `${a.slug}.md`);
    for (const file of files) expect(listed).toContain(file);
  });

  it("names only real screens, each claimed by one article", () => {
    const screens = HELP_ARTICLES.flatMap((a) => a.screens);
    for (const screen of screens) expect(`${screen} ${isPage(screen)}`).toBe(`${screen} true`);
    expect(new Set(screens).size).toBe(screens.length);
  });

  it("links only to articles and screens that exist", () => {
    for (const { slug } of HELP_ARTICLES) {
      for (const [, target] of source(slug).matchAll(/\]\((\/[^)\s]+)\)/g)) {
        const article = target.match(/^\/app\/help\/([^/?#]+)$/);
        const ok = article ? Boolean(helpArticle(article[1])) : isPage(target);
        expect(`${slug} -> ${target} ${ok}`).toBe(`${slug} -> ${target} true`);
      }
    }
  });

  it("starts each article below the page's own heading", () => {
    for (const { slug } of HELP_ARTICLES) expect(source(slug)).not.toMatch(/^# /m);
  });

  it("gives each a title and a summary", () => {
    for (const a of HELP_ARTICLES) {
      expect(a.title.length).toBeGreaterThan(5);
      expect(a.summary.length).toBeGreaterThan(20);
    }
  });
});

describe("the image", () => {
  // A source-text tripwire, for the "a copy must exist" class (rule 57): nothing imports the
  // articles, and CI boots from the checkout rather than the image, so no behaviour test
  // can see the image without them. Checked once for real with a local docker build.
  it("copies the articles into the runner, which reads them from disk", () => {
    const dockerfile = readFileSync(join(__dirname, "..", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^COPY --from=builder [^\n]*\/app\/help \.\/help$/m);
  });
});

describe("screens with no article yet", () => {
  const listed = readFileSync(join(__dirname, "fixtures", "screens-without-help.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const covered = (screen: string) => HELP_ARTICLES.some((a) => a.screens.includes(screen));
  // Help's own pages are the help.
  const screens = Object.keys(PAGE_ACCESS).filter((s) => !s.startsWith("/app/help"));

  it("lists every new screen without an article, so the gap can't grow unseen", () => {
    expect(screens.filter((s) => !covered(s) && !listed.includes(s))).toEqual([]);
  });

  it("drops a screen once it has an article, so the list can't go stale", () => {
    expect(listed.filter((s) => covered(s) || !isPage(s))).toEqual([]);
  });
});

describe("helpForScreen", () => {
  it("finds the article for a screen with an id in its path", () => {
    expect(helpForScreen("/app/sales/orders/42")?.slug).toBe("cancelling-and-changing-a-sale");
    expect(helpForScreen("/app/sales/orders/42/")?.slug).toBe("cancelling-and-changing-a-sale");
  });

  it("finds none for a screen without one, a deeper path, or nothing", () => {
    expect(helpForScreen("/app/sales/orders")).toBeUndefined();
    expect(helpForScreen("/app/sales/orders/42/edit")).toBeUndefined();
    expect(helpForScreen(undefined)).toBeUndefined();
    expect(helpForScreen(["/app/admin/audit"])).toBeUndefined();
  });

  it("needs a value where the route has one", () => {
    expect(screenMatches("/app/sales/orders/[id]", "/app/sales/orders/")).toBe(false);
    expect(screenMatches("/app/helpdesk/[id]/notes", "/app/helpdesk//notes")).toBe(false);
    expect(screenMatches("/app/helpdesk/[id]/notes", "/app/helpdesk/7/notes")).toBe(true);
  });
});

describe("helpArticle", () => {
  it("accepts only a listed slug, so a request can't name a path", () => {
    expect(helpArticle("audit-trail")?.title).toBeDefined();
    for (const slug of ["../package", "audit-trail.md", "AUDIT-TRAIL", "", null, 7]) {
      expect(helpArticle(slug)).toBeUndefined();
    }
  });
});

describe("matchingArticles", () => {
  const articles = [
    { title: "Refunds", summary: "Giving money back", text: "card or credit" },
    { title: "Price books", summary: "Importing prices", text: "PDF CSV" },
  ];

  it("keeps articles holding every word, in any case", () => {
    expect(matchingArticles(articles, "MONEY card").map((a) => a.title)).toEqual(["Refunds"]);
    expect(matchingArticles(articles, "csv").map((a) => a.title)).toEqual(["Price books"]);
    expect(matchingArticles(articles, "money pdf")).toEqual([]);
  });

  it("keeps everything for an empty search", () => {
    expect(matchingArticles(articles, "  ")).toHaveLength(2);
  });
});

describe("renderHelpMarkdown", () => {
  it("renders headings, lists, emphasis and links", () => {
    const html = renderHelpMarkdown("## Steps\n\n- **Bold** and [help](/app/help/audit-trail)\n");
    expect(html).toContain("<h2>Steps</h2>");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('<a href="/app/help/audit-trail">help</a>');
  });

  it("keeps a web link", () => {
    expect(renderHelpMarkdown("[site](https://example.com)")).toContain(
      'href="https://example.com"',
    );
  });

  it("strips anything that could run", () => {
    const html = renderHelpMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[click](javascript:alert(3))\n\n<a href="x" onclick="alert(4)">x</a>',
    );
    expect(html).not.toMatch(/script|onerror|onclick|javascript:|<img/i);
  });

  it("renders every article without losing its words", () => {
    for (const { slug } of HELP_ARTICLES) {
      const html = renderHelpMarkdown(source(slug));
      expect(html.length).toBeGreaterThan(200);
      expect(html).not.toContain("**");
    }
  });
});

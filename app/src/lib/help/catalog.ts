// /app/src/lib/help/catalog.ts
//
// The help center (GAP-30, DECISIONS 54): how-to articles for store staff, read inside
// the app only. Each article's words live in app/help/<slug>.md, so a release's help
// ships with the screens it describes. This list says what each one is called and
// which screens it explains, so the "?" on a screen opens the right one.
//
// Pure: the screen imports it too. __tests__/helpCatalog.test.ts checks every slug has
// a file, every file is listed, and every screen named here is a real page.

export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  /** Page routes as app/src/lib/auth/pagePermissions.ts names them, `[id]` and all. */
  screens: string[];
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "importing-a-price-book",
    title: "Importing a vendor's price book",
    summary:
      "Bring a vendor's wholesale prices into Holt from a PDF, CSV or spreadsheet, and replace them when a new book comes out.",
    screens: ["/app/admin/pricing/import"],
  },
  {
    slug: "cancelling-and-changing-a-sale",
    title: "Cancelling or changing a sale",
    summary:
      "Cancel a whole sale or one line, replace a line, and what happens to the money and any purchase order.",
    screens: ["/app/sales/orders/[id]"],
  },
  {
    slug: "build-your-own-reports",
    title: "Building your own reports",
    summary:
      "List or total sales, purchasing, products, customers and more, grouped and pivoted the way you need, then export them.",
    screens: ["/app/tools/query-builder"],
  },
  {
    slug: "audit-trail",
    title: "Finding who did what",
    summary:
      "The audit trail lists refunds, deletes, price changes, access changes and exports, with who did each and when.",
    screens: ["/app/admin/audit"],
  },
];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function helpArticle(slug: unknown): HelpArticle | undefined {
  if (typeof slug !== "string" || !SLUG.test(slug)) return undefined;
  return HELP_ARTICLES.find((a) => a.slug === slug);
}

/** Does a page route (`/app/sales/orders/[id]`) cover this path (`/app/sales/orders/42`)? */
export function screenMatches(screen: string, pathname: string): boolean {
  const want = screen.split("/");
  const got = pathname.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return false;
  return want.every((part, i) => (/^\[[^\]]+\]$/.test(part) ? got[i] !== "" : part === got[i]));
}

/** Articles holding every word of the query, in any case, among the words given for each. */
export function matchingArticles<T extends { title: string; summary: string; text: string }>(
  articles: T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return articles;
  return articles.filter((a) => {
    const haystack = `${a.title} ${a.summary} ${a.text}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The article for the screen at this path, or undefined when it has none yet. */
export function helpForScreen(pathname: unknown): HelpArticle | undefined {
  if (typeof pathname !== "string") return undefined;
  return HELP_ARTICLES.find((article) =>
    article.screens.some((screen) => screenMatches(screen, pathname)),
  );
}

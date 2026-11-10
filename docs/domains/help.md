# Help center

How-to articles for store staff, read inside the app (GAP-30, DECISIONS 54). Not to be
confused with `docs/domains/`, which is written for developers and agents.

Source read for this runbook: `lib/help/catalog.ts`, `lib/help/articles.ts`,
`pages/api/help/article.ts`, `components/help/HelpButton.tsx`, `app/(dashboard)/app/help/`,
`app/Dockerfile` (2026-11-10).

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| The words | `app/help/<slug>.md` | One Markdown file per article. It starts at `##`, since the title is the page's heading |
| The list | `lib/help/catalog.ts` `HELP_ARTICLES` | Each article's slug, title, summary, and the screens it explains, named as `pagePermissions.ts` names them (`/app/sales/orders/[id]`) |
| Rendering | `lib/help/articles.ts` | Reads the file, renders it with `marked`, then sanitizes with `sanitize-html` to headings, lists, emphasis, code, tables and links (relative or https) |
| The "?" | `components/help/HelpButton.tsx` in the top bar | Opens a side panel with the article for the current path, from `GET /api/help/article?screen=` |
| Help pages | `/app/help` (all articles, with search), `/app/help/[slug]` | Search matches every word typed against the title, summary and text |

**Who can read it:** anyone signed in. The route and pages need `staff.self`, which every role holds (`BASELINE_PERMISSIONS`). It's never public: the owner chose in-app only (2026-11-10).

**Only a listed slug reaches the disk.** `helpArticle()` checks the slug's shape and that it's in the list, so neither a request nor a URL can name a path.

**The image has to carry the files.** Nothing imports them, so the Dockerfile copies `app/help` into the runner like `prisma/`. CI's smoke test boots from the checkout, not the image, so it can't catch a missing copy. Verified with a local `docker build` when this was added.

**Jest compiles `marked`.** It's ESM-only, so `jest.config.ts` lists it with `@rgrove/parse-xml` in `ESM_TRANSFORMED`. The tests use the real renderer, since they prove its output is sanitized.

## Adding an article

1. Write `app/help/<slug>.md`, starting at `##`. Check every claim against the screen's code, not memory or other docs (rule 19).
2. Add it to `HELP_ARTICLES` with the screens it explains.
3. Take those screens off `__tests__/fixtures/screens-without-help.txt`.

`__tests__/helpCatalog.test.ts` fails on:

- a listed article with no file, or a file that isn't listed
- a screen that isn't a page, or one claimed by two articles
- a link to an article or screen that doesn't exist
- an article with its own `#` heading
- **the ratchet:** a new screen with no article that isn't on the fixture list, or a listed screen that now has one

## Articles so far

| Article | Screen |
|---|---|
| Importing a vendor's price book (USE-10) | `/app/admin/pricing/import` |
| Cancelling or changing a sale | `/app/sales/orders/[id]` |
| Building your own reports | `/app/tools/query-builder` |
| Finding who did what | `/app/admin/audit` |

254 screens have none yet: see the fixture.

## Not done

- **No screenshots or images.** The sanitizer allows no `img`, and articles describe the screens in words.
- **Search is in the browser,** over every article's text sent with the page. That's fine for a few dozen articles. It would need a server search past a few hundred.

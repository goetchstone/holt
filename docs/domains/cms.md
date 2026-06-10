# CMS + Public Site

The block-based content system that powers the public storefront/marketing site,
edited entirely in-app. Added 2026-06-03.

## Two surfaces, one app

- **Public site** — route group `app/src/app/(site)/`, no auth, served at `/`.
  - `/` renders the published home page (`Page.isHome`), or a branded default
    landing if none exists.
  - `/[...slug]` renders any published `Page` by slug.
  - `/blog` lists published `Post`s; `/blog/[slug]` renders one.
  - Layout (`(site)/layout.tsx`) is themed from `AppSettings` and draws header /
    footer from CMS `Menu`s.
- **Back-office** — route group `app/src/app/(dashboard)/app/`, served at `/app/*`
  (moved off `/` so the public site can own the root). Login lands at `/app`.
- Public groups `portal/`, `print/`, `health/`, and `api/` are more specific than
  the `(site)/[...slug]` catch-all, so they always win.

## Data model (`prisma/schema.prisma`)

Per `Organization` (single-org runtime = `DEFAULT_ORG_ID = 1`):

- `Page` — slug, title, status (`CmsStatus` DRAFT/PUBLISHED), `isHome`, `blocks`
  (JSON), SEO fields, `publishedAt`. Unique `(organizationId, slug)`; one `isHome`
  per org (enforced in the API, not the DB).
- `Post` — same plus excerpt, coverImageUrl, author, category, tags[].
- `Menu` — `(organizationId, location)` unique; `location` ∈ `header`/`footer`;
  `items` JSON.
- `MediaAsset` — catalog row for uploaded media (upload UI is a follow-on; block
  image fields currently take URLs).

`blocks`/`items` are nullable JSON; the parsers coerce null → `[]`.

## Block contract (`src/lib/cms/`)

- `blocks.ts` — the shared client/server contract (CLAUDE rule 7). Zod
  discriminated union over block types: `hero`, `features` (card grid), `stats`
  (value band), `richText`, `image`, `gallery`, `cta`, `embed`. `parseBlocks(json)`
  validates + drops invalid input to `[]`. Image fields use `ImageUploadField`
  (paste a URL or upload via `POST /api/cms/media`).
  `createBlock(type, id)` builds an empty block for the editor. Adding a block
  type = add its schema, add to the union, add a label, extend the factory, and
  add a renderer case + a fields case.
- `menu.ts` — `MenuItem` contract (label/href + one level of children).
- `queries.ts` — server reads for the public site (PUBLISHED only).
- `requestBody.ts` — pure zod validation for the admin API (rule 14); handlers
  stay thin. `parsePageInput` / `parsePostInput` / `parseMenuInput`.

Author HTML (`richText`, `embed`) is rendered as-is — authors are trusted
back-office staff. Sanitize at the render boundary if that ever changes.

### Section variants (background + eyebrow)

The section blocks (`features`, `stats`, `quote`, `cta`) carry two presentation
fields so a page reads with rhythm instead of a flat white scroll — both are
per-block config set in the editor, not code:

- `background`: `SECTION_BACKGROUNDS` = `default` (white) | `muted` (linen tint) |
  `dark` (navy + white text). The renderer maps each to a coordinated
  background + text-color set (`SECTION_THEME` in `BlockRenderer.tsx`); a `dark`
  CTA flips its button to the gold accent so it stays readable. Defaults preserve
  prior rendering: `stats` → `dark`, `cta` → `muted`, `features`/`quote` →
  `default`. Old content with no `background` field takes the default on parse
  (back-compat, covered in `cmsBlocks.test.ts`).
- `eyebrow` (features/quote/cta): a small gold uppercase label above the heading.

`hero` is always full-bleed navy and additionally carries `eyebrow` (gold caps
line), `headingAccent` (second headline line in gold), and `markUrl` (small
centered brand mark above the eyebrow) — all optional, empty = not rendered.
Its primary CTA renders with a trailing arrow. `richText` now carries the same
`background` field as the other section blocks (default `default` = white band);
`dark` wraps the prose in the navy band with inverted prose colors so long-form
text stays readable on dark sites. `stats` has a `variant`: `stats` (big serif
numbers grid, the default) or `checklist` (one inline row of check-marked
claims — a trust strip). Alternate `background` across consecutive sections to
get the dark/light marketing rhythm.

### Site chrome theme mode (`AppSettings.theme.mode`)

The public-site chrome (layout body, `SiteHeader`, `SiteFooter`) follows
`settings.themeMode`: `light` (default — white header bar, filled "Sign in"
button, linen footer) or `dark` (navy chrome on the brand tokens: logo +
letterspaced wordmark, outline "Staff login" button, navy footer — the full-dark
akritos.com look). Stored as `mode` inside the `AppSettings.theme` JSON (no
migration); `resolveAppSettings` surfaces it as `themeMode`, and the settings
API's `parseTheme` carries it through explicitly (that function rebuilds the
theme object from a whitelist, so an unhandled key would be dropped on every
save — covered by `appSettings.test.ts`). Toggle lives in Admin → Settings →
Theme colors → "Public site chrome". The back-office is unaffected.

## Editor (ADMIN-only, `/app/admin/cms`)

- Hub + Pages/Posts lists + block editor (`components/cms/admin/BlockEditor.tsx`
  — dnd-kit reorder, add/remove, per-type fields in `BlockFields.tsx`) + Menus
  editor. Draft/publish, slug auto-fill, SEO fields.
- API: `src/pages/api/cms/{pages,posts,menus}/*` — REST, `requireAuthWithRole(["ADMIN"])`,
  org-scoped, surfaces server messages via `getErrorMessage`.

## Feature flags

`cms` (default on) and `blog` (default off) live in `lib/featureCatalog.ts`.
Pages call `requirePage(["ADMIN"], { feature: "cms" })`; the toggles appear in
Admin → Settings → Modules automatically (the section renders `FEATURES`).

## Example content

`npm run seed:cms` (`scripts/seed-cms.mjs`) upserts a home page, an about page,
two posts, and header/footer menus for `DEFAULT_ORG_ID`. Idempotent. Run it on a
fresh deployment to get a real starting site.

## Gotchas

- Public reads go through `lib/cms/queries.ts` and filter `status: "PUBLISHED"` —
  drafts never appear publicly.
- One home page per org: setting `isHome` on a page unsets it on the others
  (transaction in the pages API).
- `publishedAt` is stamped on first publish and preserved afterward.
- The back-office lives at `/app`, not `/admin` — `/admin` remains the in-app
  system-administration section (`/app/admin/*`). Internal links use the `/app`
  prefix; the public site uses bare paths.

## Blog comments (moderated)

Gated by the **`blogComments`** feature flag (off by default; akritos enables it).

- **Model** `BlogComment` + `CommentStatus` (PENDING/APPROVED/REJECTED/SPAM),
  org-scoped, FK to `Post`. Captures `ipAddress` + `userAgent` for spam triage.
  Migration `20260604085402_add_blog_comments`.
- **Submit** — public `POST /api/comments` (rate-limited 5/min, gated on the
  feature). Lands **PENDING**. Validation in `lib/comments/requestBody.ts`.
- **Display** — only **APPROVED** comments render, via
  `getApprovedComments(postId)` in `lib/cms/queries.ts`, on
  `(site)/blog/[slug]/page.tsx`. Comment text is plain text (React-escaped — no
  HTML). The form is `components/cms/CommentForm.tsx` (inline success/error; the
  public layout has no toast container).
- **Moderate** — `/app/admin/cms/comments` (Comments card on the Content hub).
  `GET /api/admin/comments?status=` lists by status with counts;
  `PATCH /api/admin/comments/[id]` sets APPROVED/REJECTED/SPAM (approve stamps
  `approvedAt`/`approvedBy`). Contract + predicates in `lib/comments/contract.ts`
  (`isPublicComment` = APPROVED only). Tests: `commentsContract`,
  `commentsRequestBody`.

### Verification checklist

- [ ] With `blogComments` off: no comment section renders; `POST /api/comments`
      returns 404.
- [ ] With it on: a submitted comment is PENDING (not shown) until approved.
- [ ] Approving makes it appear publicly; REJECTED/SPAM never show.
- [ ] Comment body with `<script>` renders as inert text (React-escaped).

## Lead-magnet block (2026-06-10)

`leadMagnet` content block: server-rendered band + a client email-capture
form (`components/cms/LeadMagnetForm.tsx`) that POSTs to the public
rate-limited `/api/lead-magnet` (6/min, hidden `website` honeypot — bots
fill it, the server accepts silently and drops the row). Intake
(`lib/leadMagnet.ts`) creates a `WEBSITE` Lead with
`sourceDetail = lead-magnet:<sanitized tag>` or bumps an existing ACTIVE
lead for the email instead of duplicating; the endpoint always answers
`{ ok: true }` so it can't probe which emails exist. After signup the form
reveals the block's `resourceUrl` (the gated download). Editor fields in
BlockFields; block contract pinned in `__tests__/leadMagnet.test.ts`.

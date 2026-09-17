# External assessment — 2026-09-17

An independent, fresh-eyes evaluation of Holt's value and quality, produced by direct first-hand
inspection of the repository at `73daeeb` (no prior assumptions carried in). Written as a handoff
for whoever picks up the codebase next — treat it as an outside review, not an internal decision
record. Where a claim is a judgement call it is scored; where it is a fact it cites what was read.

**Baseline for the scores:** Holt is graded on the same rubric as its predecessor, the internal
pilot-deployment ERP ("furniture-configurator") that Holt was productized from. The two columns let
you see what productization bought and what it cost. furniture-configurator's numbers are the
reference point, not a target.

## Scorecard

| Dimension | furniture-configurator (baseline) | Holt | Note |
|---|---|---|---|
| **Business value** | 7 | **7** | Same DNA, productized: open-core, white-label, storefront+CMS, 2nd real deployment (Akritos), AGPL. Higher ceiling, earlier maturity. |
| Architecture | 6 | **6.5** | tRPC slice + capability system + config presets + source-adapter seam; docked for 3 coexisting API styles and unfinished money-path plumbing. |
| Testing | 7 | **7** | 304 test files / 64 integration / ~3,300 unit + a CI boot-smoke that caught real bugs; docked for 48% branch floor + a ratcheted-down functions floor. |
| Security | 5 | **6.5** | Fixed the baseline's #1 finding; semgrep+osv+sonar in CI; documented periodic security sweep w/ disposition log; encrypted creds. Docked for the tenancy marketing gap. |
| Ops/process | 6.5 | **7** | DR + secrets + deploy + migrations docs, entrypoint migrate-deploy, boot-smoke, self-audited roadmap. Still bus factor 1. |
| **Quality (composite)** | **6.3** | **~6.8** | |

**One line:** Holt is the pilot ERP's DNA turned into a product and hardened — better security
process, better ops scaffolding, more architectural ambition, decisions written down — at the cost
of more surface area, unfinished productization, and one standout labeling risk.

## What Holt is (as read from source)

A business-management platform for furniture/home-goods retailers, open-core (AGPLv3), run two ways:
self-hosted single-org, or "multi-tenant SaaS." Two surfaces from one codebase — a public themeable
**storefront + block CMS** at `/`, and the authenticated **back office** at `/app`. Next 16 (App +
Pages Router hybrid), React 19, tRPC 11, Prisma 7, Tailwind 4, NextAuth 4, Stripe. 164 Prisma models
/ 45 migrations / 5,793-line schema. 450 Pages-Router API routes + 245 App-Router routes + 6 tRPC
routers. 73 docs. 136 commits, 127 by one author.

## The headline finding — tenancy: marketing vs reality

- README + ARCHITECTURE.md sell **"Multi-tenant SaaS — one organization per customer, centrally
  hosted."**
- Reality: `organizationId` is on **16 of 164 models** — all CMS/storefront/service/billing (Page,
  Post, Menu, MediaAsset, Booking, Ticket, TimeEntry, Service, Invoice, PaymentApplication,
  AppSettings, IntegrationCredential, EmailQueue, BlogComment, AvailabilityWindow, CalendarBlock).
  The **entire money path is NOT org-scoped**: Product, Customer, SalesOrder, OrderLineItem, Payment,
  Vendor, PurchaseOrder, Inventory, StoreLocation, StaffMember, Role — no org column.
- The tRPC context (`server/trpc/context.ts`) carries `userId`/`role`/`impersonate` but **no
  organizationId**. There is **no host→org resolution and no Prisma org-scoping middleware/extension.**
  Every org-scoped path resolves to a hardcoded `DEFAULT_ORG_ID = 1` (`lib/appSettings.ts`).
- **This is honestly documented.** `docs/TENANCY.md` states single-org-per-deployment is the design
  (one DB per tenant), so the cross-tenant IDOR class "cannot manifest," and shared-DB SaaS is
  **explicitly an unsupported mode** gated behind internal task #135 (~40 models would need
  org-scoping + per-query scoping first). A 2026-06-10 security sweep logged this disposition, and
  tenant config is kept gitignored (`config/local/`).
- **Net:** the engineering is sound and honest; the top-line *marketing copy* overreaches.
  "Multi-tenant SaaS, centrally hosted" is only true as **one-DB/container-per-tenant**, not the
  shared-DB meaning most readers assume. The real risk is a self-deployer who reads the README, runs
  shared-DB multi-tenant, and mingles every tenant's money path. **Fix is a doc/labeling edit to
  README.md + ARCHITECTURE.md so they agree with TENANCY.md — not a rearchitecture.**

## Business value (7)

- Genuine productization over the baseline: white-label at runtime (branding/creds/imports in DB),
  feature-flag modules per org, storefront + in-app block CMS (no rebuilds), demo seed (~6k orders),
  a second real deployment (Akritos) exercising the de-tenant seam.
- Real market wedge: furniture-retail ERP + storefront vs weak incumbents (Ordorite, FileMaker).
- Tempered by maturity: ROADMAP (self-audited against code) says money path only "partially" —
  inventory allocation **not wired (zero call sites)**, `release()` compound-key bug open, split
  tender single-tender; de-tenant still literal in spots (CT tax district, Marjan coupling,
  `TrafficSnapshot.axperStoreName`). Bus factor 1.

## Architecture (6.5)

- Plus: tRPC + zod for new surfaces; a real capability/permission system (`lib/auth/permissionCatalog`,
  `permissionResolver`, `builtInRoles`, `roleDecision`); config presets-vs-local split; a
  source-adapter seam toward replacing Ordorite; clean storefront/back-office split via App-Router
  route groups `(site)`/`(dashboard)`.
- Minus: **three API styles coexist** (450 Pages API + 245 App routes + 6 tRPC routers) — real
  migration debt; the block CMS lib is thin (2 files) relative to the marketing; known unwired
  money-path pieces.

## Testing (7)

- 304 test files, 64 Postgres-backed integration tests, ~3,300 unit tests; honestly-measured
  coverage floors (Stmts 59 / Branches 48 / Funcs 66 / Lines 59 in `scripts/test-coverage.sh`).
  Standout: a CI **boot-smoke** job (`scripts/smoke.sh`) that reaches a populated dashboard and has
  caught a Prisma-in-browser bundle bug + broken integration fixtures that tsc and 3,300 unit tests
  could not see.
- Minus: 48% branch floor is low; functions floor was ratcheted 71→66 for two skipped service-case
  files (comment says ratchet back once un-skipped); near-zero tenant-isolation tests (defensible
  under the single-org model today, a gap the day task #135 lands).

## Security (6.5)

- Fixed the baseline's #1 finding: `api/staff/[id].ts` is `requirePermission("staff.manage")`-gated
  with a real **last-admin guard** ("Cannot remove the last admin") the baseline lacked.
- semgrep (owasp/secrets/react/next) + osv-scanner + sonar in CI; a documented periodic
  security-sweep workflow with a disposition log (`docs/TENANCY.md`, `docs/tenant-literal-sweep.md`);
  rate-limited public comment endpoint (5/min); token-gated portal; encrypted integration
  credentials; SECURITY.md.
- Minus: the tenancy labeling footgun above; single-maintainer review (bus factor 1); the
  email→userId auto-link on staff update remains (now behind the capability gate + last-admin guard,
  so materially de-risked vs the baseline).

## Ops/process (7)

- docker-compose (app+db+nginx+sonar), 45 migrations, entrypoint runs `migrate deploy`, `smoke.sh`
  on every PR, thorough `env.example`, DR/secrets/deployments/migrations docs, markdownlint, CVE
  overrides via `osv-scanner.toml`. Config presets (committed) vs local (gitignored) is a clean
  product-vs-deployment boundary.
- Minus: bus factor 1 (127/136 commits one author); a `backups/` dir in-repo — verify off-device
  retention.

## If asked "should I invest / ship it"

Strong foundation, not yet turnkey against its own bar ("runs a business nobody involved has met").
Three things gate that, none of them architectural rewrites:

1. Fix the tenancy marketing (README + ARCHITECTURE.md) so no one deploys shared-DB multi-tenant by
   mistake — align them with TENANCY.md.
2. Finish the money path: wire inventory allocation, fix the `release()` compound-key bug, finish
   split tender.
3. Address bus factor 1.

---

*Methodology: direct inspection of schema, tRPC context/procedures, auth layer, CI workflows, test
suite, and docs at `73daeeb`. Findings verified against source, not inferred from marketing. Scores
are one reviewer's judgement on a 0–10 scale shared with the furniture-configurator baseline.*

---

## Verified 2026-09-17 against `main` @ `8298bae`

The assessment above was checked claim by claim against the tree, not the docs. Most of it
holds. Where it does not, the cause is one source: the money-path and de-tenant status was
read from `ROADMAP.md` — a gitignored local planning file whose own "last audit" line names a
commit (`2b02f0d`, 2026-08-18) that already contained the fixes it calls missing. The assessment
inherited a stale list and presented it as verified. Score changes are noted where a claim
moved a score.

### Stale — already fixed before the assessment was written

| Claim | Reality |
|---|---|
| Inventory allocation "not wired (zero call sites)" | Wired since `ca499bf` (#73, 2026-08-06): `allocate()` from `create-from-cart.ts:319`, `transfers/[id]/status.ts:140`, `orderInventorySync.ts:125`; `release()` from three sites; `consume()` from `fulfilment/handover.ts:28`. |
| `release()` compound-key bug open | Fixed in `lib/inventory/allocation.ts:357-392` (`findFirst` + increment-or-create; the doc comment at `:344-355` explains why the upsert could never match). |
| Split tender single-tender | Shipped `7f3f7db` (#113, 2026-08-20): `PosView.tsx:170-180, 561-633` takes any amount ≤ balance and stays on the tender screen. |
| CT tax district literal | `lib/tax/resolveTaxRate.ts` (#75, 2026-08-07): customer → store → `AppSettings.defaultTaxDistrictId`. Remaining `"CT"` hits are comments. |
| Marjan coupling in `lib/consignment.ts` | `Vendor.isConsignment` + `lib/consignmentVendor.ts` (#128). One adapter literal remains: `/Marjan_Daily_Sales/i` in `ordorite/reportRouter.ts` `SKIP_PATTERNS`. |
| `TrafficSnapshot.axperStoreName` | Renamed `sourceStoreName` (migration `20260822120000_traffic_source_neutral`). |
| "sonar in CI" | Not in any workflow. Sonar is a local pre-PR gate (`docker-compose.sonar.yml`, `docs/CI-OPERATIONS.md:13`). |
| "a `backups/` dir in-repo" | Gitignored (`.gitignore:20`); `git ls-files backups` is empty. The reviewer counted the working tree. |
| "three API styles coexist (450 Pages + 245 App + 6 tRPC)" | The App Router has exactly one route handler — the tRPC adapter. 244 of the 245 are UI pages. Two API styles, not three. |
| "block CMS lib is thin (2 files)" | `app/src/lib/cms/` is 5 files / 579 lines plus 8 components. |
| "45 migrations" | 44; the 45th is `migration_lock.toml`. |

### Real, and sharper than stated

- **The `release()` bug *class* is not closed.** The same upsert-on-a-null-compound-key
  survives in `purchasing/orders/[id]/receive.ts:109-127`, `returns/[id]/status.ts:73-89`, and
  the CANCELLED branch of `warehouse/transfers/[id]/status.ts` — each creates a fresh free-stock
  row per call instead of incrementing. Untracked anywhere until this note.
- **Last-admin guard covers demotion only.** `api/staff/[id].ts:74` sits inside
  `if (role !== undefined)`; `DELETE` (soft-deactivate) and `PATCH isActive:false` bypass it, and
  it does not gate the email→userId auto-link at `:92-98`.
- **The pilot's initials are on the money path.** `lib/barcode.ts:4` (`SH-` barcode prefix) and
  `sales/orders/create-from-cart.ts:67` (`SH-YYMMDD-` order numbers). Not in the assessment; the
  most customer-visible tenant literal left.
- **Tenant literals: 55 of 67 remain**, now tracked per item in `docs/tenant-literal-sweep.md`.
- **Tenancy wording** is confirmed contradictory: `README.md:23`, root `ARCHITECTURE.md:5`,
  `docs/ARCHITECTURE.md:22-23` vs `docs/TENANCY.md:6,52-53`. Doc fix, as the assessment says.
- **Coverage floors** confirmed (`app/scripts/test-coverage.sh:103-106`); the two skipped
  service-case suites are still skipped and the `20260527b` migration they wait on does not exist.
- **Open issues:** one — #133 (revenue-recognition timing), whose decision was made and shipped
  (#136) but never closed. GitHub #135 is an unrelated merged seed PR; the tenancy "#135" in
  `TENANCY.md` is an internal tracker id, as that doc says.

### Score effect

Business value: the "money path only partially" deduction does not apply — allocation, release
and split tender all shipped in August. Ops: `backups/` and Sonar are non-findings. Security:
unchanged, with the guard-bypass and the `SH-` prefix added. Net: the composite reads a little
low on the baseline it was docked for, and the real open items are narrower and more specific
than the ones it named.

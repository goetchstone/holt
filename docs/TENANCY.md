# Tenancy model — the security boundary, in writing

Disposition record for the 2026-06-10 security sweep (run `wf_b28f549f-665`)
and the standing answer to "why doesn't every model carry organizationId?"

## The model today: one deployment = one tenant = one database

Holt deployments are **single-organization by design** (docs/DEPLOYMENTS.md:
"product = code, deployment = data"). Every instance — Akritos on its VPS,
a retail client on their NAS — runs its own database. `DEFAULT_ORG_ID = 1`
identifies the deployment's org row, which exists to anchor settings,
credentials, CMS content, and the white-label modules.

**Consequence:** the cross-tenant IDOR class the sweep flagged on retail-core
models (Customer, SalesOrder, GiftCard, Vendor, Payment, exports) cannot
manifest — a database only ever contains one tenant's rows, so there is no
foreign tenant to reach. The real security boundaries in this architecture
are: role gates on mutations, capability tokens on public surfaces, and the
deployment perimeter itself.

## What IS org-scoped, and why

Models born in the white-label layer (CMS Pages/Posts/Menus, Bookings,
Tickets, TimeEntries, Services, EmailQueue, PaymentApplication, authored
Invoices) carry `organizationId` and scope their queries to it. That keeps
the door open for the shared-database SaaS mode without retrofitting the
newer modules.

## What stays OUT of the white box

Tenant configuration is not product code, and does not travel with the repo:

- `config/local/` is gitignored. A deployment's real store names, traffic
  counter labels and vendor payment codes live there (`saybrook.yaml`,
  `akritos.json`). `config/presets/` — the committed set — holds only defaults
  tuned to the demo seed, so a fresh clone works without carrying anyone's
  data. `config/example.yaml` is committed as a template — at config root,
  not inside `config/local/`, because the loader would otherwise treat it as
  live configuration. See `domains/config-presets.md`.
- The same reasoning already applies to `app/scripts/seed-akritos.mjs` and
  `app/scripts/akritos-content/` (see `.gitignore`): improvements stay
  code-only, so they flow to every tenant.

The test for whether something belongs in the white box: would a second
deployment want it verbatim? Defaults yes, facts no.

## The tracked precondition for shared-DB SaaS (internal task #135)

If Holt ever serves multiple tenants from ONE database, the retail core must
first gain `organizationId` across ~40 models plus scoping on every query —
the sweep's findings list is effectively the work inventory for that
migration. Until that lands, **shared-database multi-tenancy is not a
supported deployment mode.** This is recorded on internal task #135
(multi-modal deployment — an internal task-tracker reference, not a GitHub
issue) and re-verified by the periodic security-sweep workflow.

## Sweep disposition log

- 2026-06-10: 7 confirmed findings. Fixed: `vendors/[id]` (session-only gate
  + raw body spread → MANAGER/ADMIN + field whitelist; tripwire test),
  invoice print unit-price rounding. Refuted on final source check:
  `system-gl-mappings` (already wrapped in
  `requireAuthWithRole(["MANAGER","ADMIN"])` for all methods). Won't-fix
  with rationale (this document): org-scoping on retail-core models —
  single-org-per-deployment makes the flagged boundary non-existent;
  tracked as the internal task #135 precondition instead.

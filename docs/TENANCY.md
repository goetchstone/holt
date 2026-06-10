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

## The tracked precondition for shared-DB SaaS (task #135)

If Holt ever serves multiple tenants from ONE database, the retail core must
first gain `organizationId` across ~40 models plus scoping on every query —
the sweep's findings list is effectively the work inventory for that
migration. Until that lands, **shared-database multi-tenancy is not a
supported deployment mode.** This is recorded on task #135 (multi-modal
deployment) and re-verified by the periodic security-sweep workflow.

## Sweep disposition log

- 2026-06-10: 7 confirmed findings. Fixed: `vendors/[id]` (session-only gate
  + raw body spread → MANAGER/ADMIN + field whitelist; tripwire test),
  invoice print unit-price rounding. Refuted on final source check:
  `system-gl-mappings` (already wrapped in
  `requireAuthWithRole(["MANAGER","ADMIN"])` for all methods). Won't-fix
  with rationale (this document): org-scoping on retail-core models —
  single-org-per-deployment makes the flagged boundary non-existent;
  tracked as the #135 precondition instead.

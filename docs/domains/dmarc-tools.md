# DMARC Tools (Akritos-gated)

Two public, lead-gen email-authentication tools ported from akritos.com. Gated
behind the `dmarcTools` module (default **off**, `category: "addon"`); only
the Akritos tenant enables it (`scripts/seed-akritos.mjs`). Other tenants get
a 404, and never see it as an option in Settings → Modules either (addon
modules are hidden from that toggle grid unless already on — see
`docs/domains/modules.md`).

This is the first module migrated onto the module manifest
(`src/lib/modules/registry.ts`) end-to-end: its manifest entry declares its
own `nav` (the two routes below) and `docs` (this file) instead of those
living only in prose here. It has no configurable settings, so it's the
"nav but no fields" case in the manifest design — see
`docs/domains/modules.md#the-fields-path-not-yet-load-bearing`.

## Surfaces

| Tool | Page | What it does |
|---|---|---|
| Records checker | `/tools/dmarc-check` | Server-side DNS lookups (SPF / DKIM / DMARC / MX) → parsed records, plain-English issues, 0-100 score. |
| Report analyzer | `/tools/dmarc-report` | Upload DMARC aggregate (RUA) XML/.gz/.zip → plain-English summary. |

Both live in the public `(site)` group (dark "akritos tool" palette: `midnight` /
`bone` / `conviction` / `slate-brand` tokens in `globals.css @theme`). The
`(site)` layout supplies header/footer chrome. Pages 404 via
`requireModule("dmarcTools")` (`src/lib/modules/requireModule.ts`), the
shared guard that replaced each page's own `getAppSettings()` /
`isFeatureEnabled()` / `notFound()` block.

## Files

- `src/lib/modules/registry.ts` — the `dmarcTools` `ModuleDef` (default off,
  `category: "addon"`, `nav`, `docs`). `src/lib/featureCatalog.ts` still
  exports the flat `FEATURES` list as a back-compat shim, now derived from
  this registry.
- `src/lib/modules/requireModule.ts` — `requireModule("dmarcTools")` (page
  gate, calls `notFound()`) and `isModuleEnabled("dmarcTools")` (boolean, used
  by the API route below).
- `src/pages/api/tools/dmarc-check.ts` — DNS checker API (Pages Router). Wrapped
  in `rateLimit({ windowMs: 10m, maxRequests: 20 })`; module-gated (404 when
  off) via `isModuleEnabled`. DKIM is probed against a curated static-selector
  list — selector names aren't DNS-enumerable.
- `src/lib/dmarc/decompress.ts` — client-side gzip/zip/xml decompression. Web
  standards only (no deps); magic-byte sniffing, decompression-bomb + zip-quine
  guards, one decompression level.
- `src/lib/dmarc/report.ts` — pure XML parser/aggregator. Uses `@rgrove/parse-xml`
  (rejects DTDs / external entities → XXE-immune); fixed element allowlist (no
  prototype pollution); caps on size/record count.
- `src/app/(site)/tools/dmarc-{check,report}/` — page + client form each.
- `__tests__/dmarcReport.test.ts` — parser/decompress unit tests.

## Notes

- The report flow runs **entirely client-side** — nothing is uploaded.
- `@rgrove/parse-xml` is the one new dependency (security: XXE-safe parsing has no
  stdlib equivalent).
- Nav: pages are reachable by URL and cross-link each other; surface them in the
  public nav/footer via the CMS menu when desired.

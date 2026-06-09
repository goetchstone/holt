# DMARC Tools (Akritos-gated)

Two public, lead-gen email-authentication tools ported from akritos.com. Gated
behind the `dmarcTools` feature flag (default **off**); only the Akritos tenant
enables it (`scripts/seed-akritos.mjs`). Other tenants get a 404.

## Surfaces

| Tool | Page | What it does |
|---|---|---|
| Records checker | `/tools/dmarc-check` | Server-side DNS lookups (SPF / DKIM / DMARC / MX) → parsed records, plain-English issues, 0-100 score. |
| Report analyzer | `/tools/dmarc-report` | Upload DMARC aggregate (RUA) XML/.gz/.zip → plain-English summary. |

Both live in the public `(site)` group (dark "akritos tool" palette: `midnight` /
`bone` / `conviction` / `slate-brand` tokens in `globals.css @theme`). The
`(site)` layout supplies header/footer chrome. Pages 404 via `notFound()` when
`isFeatureEnabled(settings.features, "dmarcTools")` is false.

## Files

- `src/lib/featureCatalog.ts` — `dmarcTools` feature (default off).
- `src/pages/api/tools/dmarc-check.ts` — DNS checker API (Pages Router). Wrapped
  in `rateLimit({ windowMs: 10m, maxRequests: 20 })`; feature-gated (404 when
  off). DKIM is probed against a curated static-selector list — selector names
  aren't DNS-enumerable.
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

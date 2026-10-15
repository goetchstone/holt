# Fuzzing (property-based tests)

Property-based fuzz tests live in `app/__tests__/fuzz/*.fuzz.test.ts` and use
[fast-check](https://fast-check.dev/). The `unit` Jest project's
`**/__tests__/**/*.test.ts` glob collects them, so they run in `npm test` and in
CI on every PR. Each property runs 100 times per run with a fresh random seed (the
fast-check defaults), so every CI run tries inputs no earlier run tried. Run
serially, the whole directory takes about 3 s.

A property counts only if it can fail for a real reason (CLAUDE.md principle 4).
Every property here was shown to fail against a deliberately broken copy of its
target before it was trusted, and several found real bugs on their first run.

## What is fuzzed, and why

Targets are pure functions that take untrusted input, ordered by attack surface
first and money correctness second.

| File | Target | Why it is fuzzed |
|---|---|---|
| `capabilityTokens` | `lib/booking/icsToken.ts`, `lib/capabilityToken.ts` | Unauthenticated `?token=` checks. They must never throw, and must accept only the exact token for that id and family. |
| `booking` | `lib/booking/requestBody.ts`, `serviceRequestBody.ts`, `ics.ts`, `event.ts`, `lib/email/templates.ts` | The public booking form: its body, the `.ics` a stranger downloads, and the confirmation email. The admin time-off body is included because it shares the date refine. Tests typed errors only, no injected calendar properties, and no injected markup. |
| `dmarcCheck` | `lib/dmarc/check.ts` | The public DNS checker parses TXT records the attacker writes. Tests no throw, no prototype pollution, bounded time, and the verdict and suggested fixes against an independent oracle. |
| `dmarcReport` | `lib/dmarc/report.ts`, `decompress.ts` | Report files from anyone: random bytes, corrupted zips and gzips, deeply nested XML. Tests typed errors only, lossless decompression, and summary totals that partition the messages. |
| `importEngine` | `lib/imports/engine.ts`, `transforms.ts` | Vendor and customer CSV rows, including `__proto__` headers. Tests summary partition, own-property column reads, no raw pass-through of value-mapped fields, collision-free natural keys, and CURRENCY round-trip. |
| `safePathJoin` | `lib/safePathJoin.ts` | URL path segments under `/api/uploads`. The result stays under the root or the call throws `PathTraversalError`, and ordinary names are never refused. |
| `cmsSanitize` | `lib/cms/sanitize.ts` | CMS HTML rendered on the public site. The output is re-parsed and checked against the tag, attribute, URL-scheme and iframe-host allowlists. |
| `cartPricing` | `lib/pos/cartPricing.ts` | The server prices every POS order with this. Every total must equal the sum of its parts to the cent, and no discount may make a line negative. |
| `vendorOrderParsers` | nine parsers in `lib/pricing/` | Vendor PDF and CSV text mutated line by line. Tests no throw, finite numbers only, qty x price = total, and a 50k-character line in under 500 ms. |

Shared generators and checks are in `app/__tests__/fuzz/support.ts`:
`anyString`, `nastyString` (a dictionary of known-bad tokens),
`jsonObjectWithProtoKeys`, `withoutPrototypePollution` and `timeMs`.

### Known failures

`vendorOrderParsers.fuzz.test.ts` has a `KNOWN_FAILURES` table. Each entry is a
property that fails today in a `lib/pricing/` parser, with its counterexample.
Those cases run as `it.skip` until the parser is fixed. When you fix one, delete
its entry so the property guards the fix.

## Reproducing a CI failure

On failure, fast-check prints the seed, the shrink path and the minimal
counterexample, and Jest shows them in the test output:

```text
Property failed after 57 tests
{ seed: 1679055298, path: "56:7:2:0:0:0", endOnFailure: true }
Counterexample: [...]
```

To replay that exact case locally, pass the printed object as the second argument
to the failing `fc.assert`. Merge it with any options already there:

```ts
fc.assert(fc.property(/* unchanged */), { seed: 1679055298, path: "56:7:2:0:0:0", endOnFailure: true });
```

Then run the file from `app/`, with the path before `--selectProjects` because
that flag takes several values:

```bash
npx jest __tests__/fuzz/dmarcReport --selectProjects unit
```

Fix the bug, keep the property as the regression test, and remove the replay
options before you commit.

## Adding a target

1. Pick a pure function in `app/src/lib/` that a customer, a vendor file or a
   public form can reach.
2. Create `app/__tests__/fuzz/<target>.fuzz.test.ts`. State the invariant in
   terms that do not depend on the implementation: an oracle written from the
   spec or RFC, a round-trip, totals equal to the sum of their parts,
   typed-error-only, or no prototype pollution.
3. Bias the generators toward the inputs that matter. That means dictionary
   tokens, mostly-valid inputs that reach the success path, and the
   configuration's own column names. Uniform random strings rarely get past the
   first validation check.
4. Prove that each property can fail before you trust it. Break the target
   temporarily, watch the property fail, then restore the target. Say how you did
   it in the PR.
5. Keep the run fast. Use fast-check's defaults and generous time budgets (a 50k
   character input in under 500 ms, never a tight bound). Keep the whole
   directory to about 15 s.

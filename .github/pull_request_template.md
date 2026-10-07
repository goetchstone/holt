## Summary

<!-- One or two sentences. Focus on the WHY. -->

## Trace (Rule 45)

<!--
Required if any file under lib/importHelpers*, lib/payment*, lib/auth/,
lib/secureUpload.ts, pages/api/automations/*, or any sales/PO/invoice/
payment runner is touched. Otherwise leave as N/A.

Either:
  (a) Surface is disjoint -- paste the grep that proves it:
      $ grep -rn "TouchedSymbol" src/lib src/pages/api -> 0 hits
  (b) Surface has dependents -- list each, and how it was tested.
-->

N/A

## Reproduction (Rule 46)

<!--
For bug fixes only. Required: the query / fixture / failing test that
reproduced the symptom against real data. The reproduction is the proof
the fix targets the actual cause and not a plausible-sounding hypothesis.
For features / refactors, leave as N/A.
-->

N/A

## Config-effect verification (Rule 44)

<!--
Required if this PR adds or changes a Sonar property, env var, threshold,
feature flag, or rule-tuning knob. Show before/after of the observable.
Otherwise N/A.

Example:
  Before: 234 S3776 findings
  After:  88 S3776 findings (re-scan attached)
-->

N/A

## Test plan

- [ ] `npm run validate && npm test` green locally
- [ ] Manually tested the affected flow
- [ ] Edge cases considered (null/empty/large-qty/role variations)
- [ ] If a runner / payment / auth file changed: tripwire test added in `__tests__/*.regression.test.ts` (Rule 43)

## PR purity (Rule 45)

- [ ] Branched off `origin/main`, not another feature branch
- [ ] `git log --oneline origin/main..HEAD` shows only intended commits

## Docs (Rule 36)

- [ ] CLAUDE.md rules / gotchas updated if applicable
- [ ] `docs/domains/*.md` runbook(s) updated
- [ ] ROADMAP.md updated if a roadmap item was shipped

## Security review

- [ ] No change to auth/role gates, OR new gates verified
- [ ] No secrets or debug logging left in
- [ ] IDOR guard added if the endpoint takes a nested ID
- [ ] If touched: `spawn(absolute path)` not bare binary name (Rule 44 / S4036)
- [ ] If touched: `crypto.randomBytes` not `Math.random` for any value used as a path/token/secret (Rule 44 / S2245)

## Sonar / scans (Rule 48)

- [ ] No new findings introduced (or new findings explicitly fixed/tripwired/won't-fixed in this PR)
- [ ] If a regression caused this PR: failure log entry added to `.claude/skills/post-failure/SKILL.md`

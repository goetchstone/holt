## What changes, and why

<!-- A sentence or two. Link the issue this closes: "Closes #123". -->

## How it was verified

<!--
Say what you ran and what you could not run. For a bug fix: the test that
fails without the change and passes with it.
-->

- [ ] `cd app && npm run validate && npm test` pass locally
- [ ] A test covers the new behaviour and fails without the change
- [ ] Tried the affected screen or flow by hand

Not verified:

## Trace (Rule 45)

<!--
Only if the change touches code many paths share (auth, payments, uploads,
import runners, automations): list the callers you checked, or the grep that
shows there are none. Otherwise N/A.
-->

N/A

## Checklist

- [ ] One change, branched from `main`
- [ ] Docs updated where this makes them untrue, including the `docs/domains/` runbook for the area (Rule 36)
- [ ] No change to who may do or see something, or the new gate is tested
- [ ] No secrets, real customer data or debug logging

## Scans: lint, Semgrep, OSV, CodeQL (Rule 48)

- [ ] No new findings, or each one is fixed, covered by a test, or explained here as won't-fix

# Rule feedback ledger

Append-only. **Observations go here, not into CLAUDE.md.**

That split is the point. Deciding what deserves a constitutional rule *while the
incident is still warm* is how CLAUDE.md reached 65 numbers with gaps and five
conflicting citations — every session, in the moment, judged its own bruise
worth a rule. This ledger costs nothing to write and commits to nothing. The
judgment happens later, with distance, in
`.claude/skills/improve-rules/SKILL.md`.

So: write the entry even when you are not sure it matters. An entry that turns
out to be noise costs one line. The entry you skipped because it felt too small
is the one the next incident needed.

## Format

One entry per observation, newest at the bottom.

```
### YYYY-MM-DD — one-line summary

- **Signal:** fix-commit <sha> | CI failure <run url> | user correction | tripwire fired | near miss
- **What happened:** what was proposed or shipped, and what reality required instead.
- **Principle:** the CLAUDE.md principle this is an instance of, or `NEW` if none fits.
- **Would a rule have caught it?** yes (which) / no / only if enforced differently (how).
```

The last field is the one that matters. "No" is a useful answer — it means the
rules were fine and something else failed. "Only if enforced differently" is the
most useful of all: it says the rule exists but lives in the wrong layer, which
is a change to *where* it is enforced, not to *what* it says
(`docs/FRAMEWORK.md` §3: skill / hook / tripwire).

## Entries

### 2026-08-26 — a drift test compared words instead of decisions, and passed while broken

- **Signal:** user correction + fix-commit `412a314`
- **What happened:** `setup.sh` reimplements `guard.ts`'s database allowlist in
  shell. The test asserting the two stayed in step checked that the shell file
  *contained the same tokens*. It did — while using unanchored substring globs
  against the guard's word-bounded regex, so `setup.sh` accepted `holt_samples`
  and `demolition_prod`, ran migrate and seed:roles into them, and only then did
  the seed refuse. The test passed the entire time this was broken.
- **Principle:** 4 (verify with an instrument that can disagree).
- **Would a rule have caught it?** Only if enforced differently. Rule 12 already
  says tests exercise actual behaviour; nothing says that when one rule has two
  implementations, the test must compare their *decisions* over a shared input
  set rather than their text. Candidate strengthening of principle 4.

### 2026-08-26 — permissive defaults invented a deployment fact

- **Signal:** fix-commit `412a314`
- **What happened:** de-tenanting turned hardcoded literals into config with
  permissive defaults so nothing broke unconfigured. `[A-Z]{2,}` as a store code
  classified `SOFA1` and `MEGA1234` as returns and subtracted them from revenue;
  `.+_` as a report-name prefix routed `Deleted_Customers.csv` into the customer
  master. Both were invisible: no fixture used a non-store word.
- **Principle:** 7 (deployment facts are configuration).
- **Would a rule have caught it?** No — rules 61-63 covered moving the literal
  out, and said nothing about what the default should be. Added to 63 as
  "unconfigured must fail closed, not guess", cited to this incident.

### 2026-08-26 — the guard against publishing identifiers published them

- **Signal:** tripwire fired (own audit)
- **What happened:** `clientDataTripwire.test.ts` listed, in plaintext in a
  public repo, the surnames, town names, ZIP and phone numbers it existed to
  keep out — concentrating in one indexed file exactly what every other file had
  been scrubbed of.
- **Principle:** 3 (a guard on one path is no guard) — obliquely; the real shape
  is "the guard is inside the set it guards".
- **Would a rule have caught it?** No. Possibly too narrow to generalise; left
  here rather than promoted, as a data point in case a second instance appears.

### 2026-09-23 — a specified AppSettings + UI design shipped as env vars to dodge a migration

- **Signal:** user correction (repeated)
- **What happened:** VAL-04 moved the hardcoded Google Drive projects folder and
  Slides template out of `create-project.ts`. The package specified `AppSettings`
  keys (`google.drive.*`, `google.slides.*`) plus fields on the Settings →
  Integrations page. It shipped instead (PR #183) as env vars, justified in the
  PR body as "to avoid another migration". The owner corrected it — "if a
  migration is the correct way do it, we always do things the correct way",
  "quality and correctness over quickness", "KISS", "KISS was always supposed to
  be fundamental" — and #183 is being reworked to the specified design.
- **Principle:** NEW → reinstated as principle 11 (Keep it simple), rule 66. The
  incident is *under*-building, not over-building: the shortcut was less than the
  specified design, dressed up as simplicity.
- **Would a rule have caught it?** Only if enforced differently. KISS (retired
  rule 1) named the value but carried no incident and no enforcement home, so
  nothing fired when "to avoid a migration" justified the substitute. Reinstated
  with both: rule 66 + `.claude/skills/pre-pr` item 13. Also captured in PLAN.md
  rule 0.1.12 for this plan's execution.

### 2026-10-01 — a unit-test run wrote rows into the developer database

- **Signal:** near miss (own audit)
- **What happened:** to run the integration suite, `DATABASE_URL` was exported
  in a shell that then ran the pre-push hook. The hook's unit tests reached the
  error recorder, which wrote `ErrorEvent` rows into `fbc_dev_db` (one created,
  one incremented). The integration harness swaps to `fbc_test_db` and guards
  the name; the unit project had no guard and used whatever URL it inherited.
  #225 added `jest.no-database.setup.ts`, which removes every `*DATABASE_URL`
  from the unit and performance projects.
- **Principle:** 3 (a guard on one path is no guard): rule 59's database guard
  covered the integration path only.
- **Would a rule have caught it?** Only if enforced differently: rule 59 says
  only `fbc_test_db` may be written, but nothing enforced it outside the
  integration harness. #225 is the enforcement.

### 2026-10-01 — "View cost" under View as answered from the viewed role alone

- **Signal:** near miss (a design review's skeptic, before any user saw it)
- **What happened:** #224 answered keys beside a gate (`{ also }`) exactly as a
  gate decides, so under View as they followed the viewed role's grants. An
  administrator whose role the owner had edited to untick View cost could view
  as MANAGER and get every cost figure back, on all six PRs shipped under the
  key (#224-#229). The menu already intersected the real and viewed roles
  (`resolveViewerPermissions`); the server did not. Fixed in SEC-14 PR 11a.
- **Principle:** 6 (one home per fact): "what may a viewer see under View as"
  was decided twice, differently, in the menu and in the resolver.
- **Would a rule have caught it?** No. Each PR's review probed impersonation
  only with unedited roles, where both answers agree. The case that splits them
  is an edited real role viewing as an unedited one.

### 2026-10-01 — tests of a server page re-ran its logic instead of rendering it

- **Signal:** near miss (adversarial review of #229)
- **What happened:** the Open Orders and Consignment Summary tests called
  `requirePage(...)` and the strip function themselves, rebuilding what the page
  does. A page that skipped the strip, or passed `true`, would still have passed.
  Both now render the page's default export and read the props it hands the
  client view.
- **Principle:** 4 (verify with an instrument that can disagree).
- **Would a rule have caught it?** Only if enforced differently: rule 12 asks
  for actual behaviour, but nothing says that for a server component the
  behaviour is the element it returns.

### 2026-10-22 — the CVE gate went red twice between a sweep and its merge train

- **Signal:** tripwire fired (Dependency CVE scan, npm advisory audit)
- **What happened:** #45 swept the advisories that had turned the scan red on
  main. Hours after it opened, two critical unauthenticated RCEs in Next
  16.0.0–16.4.0 were published; on 2026-10-23, advisories against zod,
  nodemailer and fast-uri followed, each after the branch's last push. The
  sweep was re-run when the train started (2026-10-24) and caught the second
  batch on #45 itself, so none of the PRs queued behind it went red for a reason
  unrelated to it.
- **Principle:** 10 (own the version state you depend on).
- **Would a rule have caught it?** Yes: rule 55, and it did. Recorded because a
  guard that fired is the evidence a retirement argument will ask for. What it
  adds: the sweep that counts is the one run when the train starts, not when the
  sweep PR opens.

### 2026-10-22 — a clean `npm ci` leaves typecheck red until the Prisma client is generated

- **Signal:** near miss
- **What happened:** verifying #45 with the dependency-sweep skill's Step 5
  (`rm -rf node_modules && npm ci && npm test`), `npm run validate` afterwards
  failed typecheck. `npm ci` does not run `prisma generate`, and
  `app/package.json` has no `postinstall` that would; `npx prisma generate`
  fixed it. Step 5 stops at `npm test` and never runs typecheck.
- **Principle:** 4 (an instrument that can disagree): the step the skill names
  as the clean-install check does not exercise the gate that broke.
- **Would a rule have caught it?** Only if enforced differently: rule 52 is
  right, but the skill's command should be `npm ci && npx prisma generate &&
  npm run validate && npm test`.

### 2026-10-22 — two docs said the entrypoint seeds the roles; the source said a migration does

- **Signal:** near miss (found while changing the entrypoint for #46)
- **What happened:** `docs/domains/seed-data.md` and a comment in
  `prisma/seed/coverage.ts` said the container entrypoint seeds the system
  roles. The entrypoint runs `migrate deploy` and then `next start`; the roles
  are inserted by migration `20260806160000_role_and_role_permission` and
  reconciled at boot by `src/instrumentation.ts`. #46 corrected both.
- **Principle:** 5 (a claim is exactly as strong as its evidence), rule 56.
- **Would a rule have caught it?** Rules 19 and 56 did, once the entrypoint was
  opened. Nothing re-checks a runbook's claim when the file it describes
  changes.

### 2026-10-24 — a search across env files printed a database URL into the transcript

- **Signal:** near miss
- **What happened:** a `grep` for where a connection setting is read matched a
  local env file and printed the start of its `DATABASE_URL`, part of the
  password included, into the session transcript. Local Docker database only,
  no deployment's credential; disclosed to the owner at the time.
- **Principle:** `NEW`: no principle covers what tool output exposes.
- **Would a rule have caught it?** No. The habit that prevents it is
  `grep -l` (file names only) or printing only the key (`cut -d= -f1`) when the
  search can reach an env file.

### 2026-10-27 — the rules improver's trigger cannot fire in this repository

- **Signal:** near miss (own audit, asked to run the learning routines)
- **What happened:** `.claude/hooks/rules-improver-check.sh` counts commits whose
  subject starts with `fix` or `revert`, plus ledger entries dated after
  `.claude/.rules-last-run` (2026-10-02). Since the fresh repository
  (2026-10-07) every commit on main is a squash merge titled in prose ("The CVE
  gate is green again: …"). Of the 31 commits since the stamp none starts with
  either word, though several are fixes (#38, #45, #46), and the ledger's last
  entry before today was 2026-10-01. So at every session start for three weeks
  the hook counted 0 against a threshold of 8 and, below threshold, printed
  nothing. Silence read as "nothing to learn".
- **Principle:** 4 (an instrument that can disagree), and rule 65's "prove the
  tripwire in both directions": the count was right for the old history's
  `fix:` subjects and was never re-proven when the commit style changed.
- **Would a rule have caught it?** Only if enforced differently: the signal has
  to come from something this repository still writes (merged PRs whose head
  branch starts `fix/`, `sec/` or `revert/`, or the ledger alone), and a count
  of zero on both inputs should be reported rather than read as quiet.

### 2026-10-27 — eight PRs took eight serial CI cycles over three days to land

- **Signal:** process observation
- **What happened:** main requires branches to be up to date and has no merge
  queue, so each merge put every other PR behind, and each needed an update and
  a full CI run in turn (#45, #40, #41, #39, #46, #44, #49, #50). Each merge
  needed a human nudge, because the app's CI monitor wakes a session on a
  failure but not on a merge. Meanwhile Dependabot closed and reopened its
  grouped bump twice (#42, then #48, then #50) as the train landed some of its
  packages.
- **Principle:** not a rules problem.
- **Would a rule have caught it?** No. Recorded so the next train knows the
  cost. A merge queue would remove it; that is a ruleset decision for the owner.

### 2026-10-27 — Dependabot's update job failed 15 times on main and nobody saw

- **Signal:** near miss (found by the 2026-10-27 improver pass reading CI failures)
- **What happened:** since 2026-10-07, 15 of 42 "Dependabot Updates" runs on
  main failed. The latest says `npm error Override for postcss@8.5.31 conflicts
  with direct dependency` (EOVERRIDE): `app/package.json` declares `postcss`
  both as a devDependency and as an override, so a bump of the direct one
  breaks the override and the update is dropped. No PR, check or session start
  surfaces a failed Dependabot job, so it failed into a log.
- **Principle:** 4 (an instrument that can disagree) and rule 65's third part:
  the job runs unattended, but its failure reaches no one. It is the fourth
  instance found 2026-10-27, with the improver trigger, the warn-only weekly
  Trivy job and `ci.yml`'s missing push trigger (#39).
- **Would a rule have caught it?** Only if enforced differently: rule 65 asks
  for a gate that runs unattended, not for its failure to reach someone.
  Proposed for the next pass (`ROADMAP.md`, "Learning loop", item 5).

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

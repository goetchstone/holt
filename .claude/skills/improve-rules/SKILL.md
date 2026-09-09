---
name: improve-rules
description: Observer pass over accumulated evidence that proposes one focused edit to CLAUDE.md as a PR. Run when the fix-commit counter trips, or on demand when the rules feel stale. Never edits CLAUDE.md directly on main.
---

# Improve the rules

This is the **outer** skill. The inner skill is `CLAUDE.md` itself — the
constitution every session reads. This one observes how that constitution
performed and proposes a change to it.

Two properties make it work, and dropping either turns it into rule bloat:

**It runs with distance.** Not mid-task, not while the incident is warm. The
agent that just got burned is the worst judge of whether its bruise deserves a
constitutional rule — that instinct is exactly how this file reached 65 numbers
with gaps and five conflicting citations. Evidence accumulates in
`docs/RULE-FEEDBACK.md`; judgment happens here, later, over the pile.

**It proposes, it does not decide.** Output is a pull request against `main`,
one focused edit, for a human to accept or reject. Nothing here writes to
`main`.

## What counts as feedback here

Warp's version of this loop reads human PR review comments. **That signal does
not exist in this repo** — 20 merged PRs carry 0 reviews and 1 comment between
them, because `docs/FRAMEWORK.md` describes a solo project with no second pair
of eyes. Do not go looking for it and conclude there is nothing to learn.

The equivalent signal here is **the commit that had to clean up after the last
one**. A `fix:` or `revert:` commit is literally "what the agent proposed versus
what reality required", with a diff attached and no friction to capture. Roughly
one commit in four is one.

Read all four sources:

1. **Fix and revert commits since the last run.**

   ```bash
   git log --oneline --since="$(cat .claude/.rules-last-run 2>/dev/null || echo '6 weeks ago')" \
     --format='%h %s' | grep -iE '^[a-f0-9]+ (fix|revert)'
   ```

   For each, read the diff. The question is never "was this a bug" — it is
   **"which principle was in force, and why didn't it hold?"**

2. **The ledger** — `docs/RULE-FEEDBACK.md`, entries since the last run. Pay
   particular attention to entries answering *"only if enforced differently"*:
   those are the highest-value changes, because the rule already exists and is
   simply in the wrong layer.

3. **CI failures on merged PRs.** `gh run list --status failure --limit 30`.
   Which gate caught what. A class that repeatedly reaches CI before anything
   catches it wants an earlier gate; a gate that has never fired is a
   retirement candidate.

4. **Tripwire and hook firings.** A guard that fired and caught something is
   evidence its rule earns its place — worth recording, because retirement
   arguments later will ask.

## The judgment

Sort every piece of evidence into exactly one of these. Most land in the middle
two, and that is the useful finding.

| Finding | What it means | Action |
|---|---|---|
| **New failure mode** | No principle covers this shape | Propose a new principle, or a new numbered rule under an existing one |
| **Known mode, wrong layer** | A rule says it; nothing enforces it where it broke | Move enforcement: skill → hook → tripwire (`docs/FRAMEWORK.md` §3). **No text change.** |
| **Known mode, weak wording** | The rule is right but permitted this reading | Sharpen the rule's own text; keep it checkable |
| **Not a rules problem** | The rules were fine; something else failed | Record it in the ledger and change nothing |

**"Not a rules problem" is a real and frequent verdict.** A pass that proposes a
change every time it runs is not learning, it is accreting. Returning "no change
warranted, here is why" is a successful run.

## The bar for any proposed edit

Every one of these, or it does not ship:

- **Cite the incident.** Commit SHA, PR number, or ledger entry. No citation, no
  rule — `docs/FRAMEWORK.md`: *rules earn their place by surviving incidents.*
- **Name the enforcement home.** Skill, hook, or tripwire. A rule with nowhere to
  live is a wish.
- **Prefer strengthening a principle over adding a number.** Most incidents are
  new instances of a named failure mode. A new number is for a mode that is
  genuinely new.
- **Preserve every number.** 203 files cite rules by number. Never renumber,
  never reuse, never delete a number anything still cites — demote to the
  runbook with the number intact.
- **One change per PR.** So it can be judged on its own and reverted on its own.

## Retirement

Same evidence bar, opposite direction. A rule stops earning its place when:

- its code path no longer exists; or
- its guard has never fired and the class it prevents has not recurred; or
- nothing cites it and no incident is attached to it.

Check citations before proposing removal:

```bash
git grep -c "rule ${N}\b" -- . | wc -l
```

Demote to the matching runbook with the number preserved so citations resolve.
Delete a number outright only when nothing cites it — and record it under
`## Retired` in CLAUDE.md with the evidence, so the next pass does not
re-litigate it.

## Running it

```bash
git checkout -b chore/improve-rules-$(date +%Y%m%d)
```

Make the single edit. Then:

- Re-run the check that would have caught the original incident, and confirm it
  now fails without the change and passes with it. A rule proposed without that
  demonstration is a guess.
- PR body: the evidence, the finding category from the table above, and what the
  change would have prevented. Link the commits.
- Stamp the run so the next pass reads the right window:

  ```bash
  date -u +%Y-%m-%d > .claude/.rules-last-run
  ```

Then stop. A human merges it, and the next session inherits the improvement.

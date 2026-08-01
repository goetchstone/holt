---
name: end-of-session
description: Run the end-of-session doc update checklist from CLAUDE.md rule 36. Use at the end of every working session before wrapping up.
---

# End-of-Session Doc Update Checklist

Run through every item below. Update any file that changed during this
session.

## Checklist

1. **CLAUDE.md** — only if a genuinely cross-cutting rule was learned (an
   incident, not a preference). Don't append domain gotchas here — they go
   in the matching runbook (rule 19/36).
2. **ROADMAP.md** — mark completed features Done, update priorities.
3. **Domain runbooks** (`docs/domains/*.md`) — update any runbook touched
   during this session; bump its "Last verified" date if you re-checked it
   against source.
4. **`.claude/skills/post-failure/SKILL.md`** — add an entry if this
   session fixed a production bug (see that skill for the format).
5. **`docs/OPERATIONS.md` / `docs/DEPLOYMENTS.md`** — if deployment, cron,
   or infrastructure changed.
6. **`osv-scanner.toml`** — if a CVE suppression's rationale needed
   re-verification this session (rule 54), confirm the comment reflects
   what was actually re-checked, not just a renewed date.
7. **Memory** (`~/.claude/projects/<project>/memory/`) — one fact per
   file, indexed by `MEMORY.md`. Add a memory only for something durable,
   NOT already recorded in the repo, that would cost a future session real
   time to rediscover. Don't duplicate what CLAUDE.md, a runbook, or the
   failure log already says.

## Rules

- Update "Last verified" dates on any runbook that was read or modified.
- Commit doc updates as a separate atomic commit:
  `docs: end-of-session update for YYYY-MM-DD` — acceptable after the
  feature commit, but before the session ends.
- Do NOT create new documentation files unless explicitly requested.
- Run `npm run validate` and `npm test` one final time before the doc
  commit.
- Deferred work has a tracked endpoint (spawned task or `ROADMAP.md` entry)
  before the session ends — not just a mention in chat (rule 50).
- The `start-session` skill reads these docs next time — keep them
  accurate.

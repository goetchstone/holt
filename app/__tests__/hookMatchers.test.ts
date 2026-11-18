// /app/__tests__/hookMatchers.test.ts
//
// Behavior tests for the command matchers in `.claude/hooks/pre-pr-check.sh`
// and `.claude/hooks/pre-commit-check.sh`. Runs the real scripts with
// HOLT_HOOK_MATCH_ONLY=1, which makes a matched command exit 10 right after the
// match (nothing else runs) and an unmatched one exit 0.
//
// Why: the pre-pr matcher was `(^|; *| && *)gh pr create`, so
// `GH_TOKEN=$(gh auth token --user x) gh pr create --fill`, `GH_TOKEN=x gh pr create`
// and `cd app && GH_TOKEN=x gh pr create` all skipped the coverage and doc gates,
// and the pre-commit matcher missed `git -C <path> commit`. A gate that does not
// fire is no gate (CLAUDE.md rule 42). The matchers fail closed: a false positive
// (words inside a quoted string) is accepted, a miss is not.

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HOOKS = join(__dirname, "..", "..", ".claude", "hooks");
const MATCHED = 10;

function exitFor(script: string, command: string): number | null {
  const r = spawnSync("bash", [join(HOOKS, script)], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, HOLT_HOOK_MATCH_ONLY: "1" },
    timeout: 20000,
  });
  return r.status;
}

const PR_MUST = [
  "gh pr create",
  "gh pr create --fill",
  'gh pr create --title "x" --body "y"',
  "export GH_TOKEN=x; gh pr create",
  "git push && gh pr create --fill",
  "false || gh pr create",
  "git log | gh pr create",
  "GH_TOKEN=x gh pr create",
  "GH_TOKEN=$(gh auth token --user someone) gh pr create --fill",
  'GH_TOKEN="$(gh auth token --user someone)" gh pr create --fill',
  "cd app && GH_TOKEN=x gh pr create",
  "A=1 B=2 gh pr create",
  "(cd app && gh pr create)",
  "echo hi\ngh pr create",
  "if true; then gh pr create; fi",
  "gh -R owner/repo pr create",
];
const PR_MUST_NOT = [
  "gh pr view 1",
  "gh pr list",
  "gh pr checks 3",
  "git status",
  "gh pr create-something-else-x",
  "echo done",
  "gh issue create",
];

const COMMIT_MUST = [
  "git commit -m x",
  'git commit -am "msg"',
  "git add . && git commit -m x",
  "git add .; git commit -m x",
  "false || git commit -m x",
  "GIT_AUTHOR_NAME=x git commit -m y",
  "GIT_AUTHOR_NAME=$(whoami) git commit -m y",
  "cd app && GIT_X=1 git commit -m y",
  "git -C /some/path commit -m x",
  'git -C "/some path" commit -m x',
  "git -c user.name=x commit -m y",
  "git -c a=b -C /p commit -m y",
  "(git commit -m x)",
  "git --no-pager commit -m x",
];
const COMMIT_MUST_NOT = [
  "git status",
  "git log --grep commit",
  "git log --oneline",
  "git diff HEAD",
  "git commit-tree abc",
  "git push origin main",
  "ls commit",
];

describe("pre-pr-check.sh matcher", () => {
  it.each(PR_MUST)("fires for %j", (c) => {
    expect(exitFor("pre-pr-check.sh", c)).toBe(MATCHED);
  });
  it.each(PR_MUST_NOT)("stays quiet for %j", (c) => {
    expect(exitFor("pre-pr-check.sh", c)).toBe(0);
  });
});

describe("pre-commit-check.sh matcher", () => {
  it.each(COMMIT_MUST)("fires for %j", (c) => {
    expect(exitFor("pre-commit-check.sh", c)).toBe(MATCHED);
  });
  it.each(COMMIT_MUST_NOT)("stays quiet for %j", (c) => {
    expect(exitFor("pre-commit-check.sh", c)).toBe(0);
  });
});

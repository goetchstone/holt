// /app/__tests__/prePrCheckRoot.test.ts
//
// Which checkout .claude/hooks/pre-pr-check.sh inspects. The hook is configured
// in the main checkout, so it used to diff that checkout's origin/main...HEAD:
// main against main, nothing. Every PR opened from a worktree (#133 to #136)
// passed the doc and coverage gates without being looked at. It now resolves
// the checkout the PR is opened from; this drives the real script against a
// real temporary worktree and reads where it would look (HOLT_HOOK_PRINT_ROOT).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = realpathSync(join(__dirname, "..", ".."));
const HOOK = join(ROOT, ".claude", "hooks", "pre-pr-check.sh");
const PRINTED = 11;

const branch = `hook-root-test-${process.pid}`;
let parent: string;
let worktree: string;

// Run from the pre-push hook, git exports GIT_DIR and friends; a child that
// inherits them reads the pushing checkout, whatever directory it is given.
const CLEAN_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(CLEAN_ENV)) {
  if (key.startsWith("GIT_")) delete CLEAN_ENV[key];
}

function git(...args: string[]) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: CLEAN_ENV,
  });
}

/** The checkout the hook resolves for `command`, run from `cwd` (the hook input's). */
function rootFor(command: string, cwd?: string): string {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_input: { command }, ...(cwd ? { cwd } : {}) }),
    encoding: "utf8",
    env: { ...CLEAN_ENV, HOLT_HOOK_PRINT_ROOT: "1" },
    timeout: 20000,
  });
  expect(r.status).toBe(PRINTED);
  return realpathSync(r.stdout.trim());
}

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "holt-hook-root-"));
  worktree = join(parent, "wt");
  git("worktree", "add", "-b", branch, worktree, "HEAD");
  worktree = realpathSync(worktree);
});

afterAll(() => {
  try {
    git("worktree", "remove", "--force", worktree);
  } finally {
    try {
      git("branch", "-D", branch);
    } catch {
      // Already gone.
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

describe("pre-pr-check.sh inspects the checkout the PR is opened from", () => {
  it("takes the worktree that has the --head branch checked out", () => {
    expect(rootFor(`gh pr create --head ${branch} --fill`, ROOT)).toBe(worktree);
    expect(rootFor(`GH_TOKEN=x gh pr create --base main --head=${branch}`, ROOT)).toBe(worktree);
    expect(rootFor(`gh pr create -H someone:${branch}`, ROOT)).toBe(worktree);
  });

  it("takes a leading cd, a subdirectory resolving to its checkout", () => {
    expect(rootFor(`cd ${worktree} && gh pr create --fill`, ROOT)).toBe(worktree);
    expect(rootFor(`cd "${worktree}/app" && gh pr create --fill`, ROOT)).toBe(worktree);
  });

  it("takes the session's working directory when the command names neither", () => {
    expect(rootFor("gh pr create --fill", worktree)).toBe(worktree);
  });

  it("falls back to its own checkout, as before", () => {
    expect(rootFor("gh pr create --fill")).toBe(ROOT);
    // A --head with no worktree of its own does not decide; the cwd does.
    expect(rootFor("gh pr create --head no-such-branch-anywhere", worktree)).toBe(worktree);
  });
});

// /app/__tests__/prePushHook.test.ts
//
// Behavior tests for the `.githooks/pre-push` git hook. Spawns the hook
// as a subprocess with synthetic stdin and asserts on exit code + stderr.
//
// Why this test exists: 2026-04-29 found that the pre-push hook ran
// `npm run validate && npm test` on every push, INCLUDING `git push
// origin --delete <branch>` invocations -- ~30s wasted per delete x 23
// branches during a cleanup sweep = ~12 min of pointless work. The fix
// (track non-deletion-ref count, exit early if all refs are deletions)
// would have benefited from a test before shipping; instead the bug
// was found in production-adjacent flow. This test pins the fix.
//
// A-grade behavior test: exec's the actual shell script, real stdin,
// real exit code. No mocks. The hook is bash + a couple of cases, so
// the matrix is small enough to enumerate.

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HOOK_PATH = join(__dirname, "..", "..", ".githooks", "pre-push");

const ZERO_SHA = "0000000000000000000000000000000000000000";
const REAL_SHA = "abcdef1234567890abcdef1234567890abcdef12"; // arbitrary non-zero

const REPO_ROOT = join(__dirname, "..", "..");

function runHook(stdin: string): { code: number; stdout: string; stderr: string } {
  // First arg to the hook is the remote name (per githook spec).
  // We pass "origin" because the hook reads it but doesn't do anything
  // remote-dependent in the early-exit path we're testing.
  // cwd must be the repo root because the hook does `cd app` after the
  // early-exit; running from app/ would make that `cd app` fail and
  // mask the real exit semantics we want to test.
  const result = spawnSync("bash", [HOOK_PATH, "origin"], {
    input: stdin,
    encoding: "utf8",
    timeout: 10_000,
    cwd: REPO_ROOT,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("pre-push hook — deletion handling", () => {
  it("exits 0 silently-ish when all refs are deletions (single ref)", () => {
    const stdin = `refs/heads/test ${ZERO_SHA} refs/heads/test ${ZERO_SHA}\n`;
    const r = runHook(stdin);
    expect(r.code).toBe(0);
    // Should report the deletion count + skip message somewhere in output.
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("skipping validate");
    expect(combined).toContain("1 branch deletion");
    // Crucially, validate / tests should NOT have run -- if they had, this
    // would have taken seconds, not milliseconds. (We can't easily assert
    // on time but the absence of any validate output is the proxy.)
    expect(combined).not.toMatch(/lint|prettier|tsc|jest passed/i);
  });

  it("exits 0 when MULTIPLE refs are all deletions", () => {
    // Simulates the cleanup sweep that surfaced the original bug.
    const stdin =
      `refs/heads/old-feature-1 ${ZERO_SHA} refs/heads/old-feature-1 ${ZERO_SHA}\n` +
      `refs/heads/old-feature-2 ${ZERO_SHA} refs/heads/old-feature-2 ${ZERO_SHA}\n` +
      `refs/heads/old-feature-3 ${ZERO_SHA} refs/heads/old-feature-3 ${ZERO_SHA}\n`;
    const r = runHook(stdin);
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("3 branch deletion");
    expect(combined).toContain("skipping validate");
  });
});

describe("pre-push hook — protected branch refusal", () => {
  it("exits 1 when pushing a non-deletion ref to main", () => {
    // local_sha is real (not zeros) and remote_ref is refs/heads/main.
    const stdin = `refs/heads/main ${REAL_SHA} refs/heads/main ${ZERO_SHA}\n`;
    const r = runHook(stdin);
    expect(r.code).toBe(1);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("refusing direct push");
    expect(combined).toContain("main");
    // The deletion early-exit must NOT fire on a non-deletion push.
    expect(combined).not.toContain("skipping validate");
  });

  it("does NOT refuse a deletion push to main (delete-the-protected-branch is rejected by GitHub server side anyway, but the hook itself is permissive)", () => {
    // This documents the contract: the deletion early-exit takes priority
    // over the protected-branch check inside the loop. A user trying to
    // delete main would be stopped by GitHub's branch protection ruleset
    // (server-side, since 2026-04-29), not by this hook.
    const stdin = `refs/heads/main ${ZERO_SHA} refs/heads/main ${ZERO_SHA}\n`;
    const r = runHook(stdin);
    expect(r.code).toBe(0);
  });
});

describe("pre-push hook — mixed pushes", () => {
  it("falls through to validate when the push contains at least one non-deletion ref", () => {
    // Mix: one deletion, one normal push to a feature branch.
    // The hook should NOT take the all-deletion early-exit; it should
    // fall through to the validate block. We can't easily run npm in
    // this test environment, so we verify by ensuring:
    //   (a) the "skipping validate" early-exit message is absent
    //   (b) the script attempted to run validate (which would emit
    //       the "running validate + tests" line OR fail trying to cd
    //       into app/ if the cwd is wrong).
    const stdin =
      `refs/heads/old ${ZERO_SHA} refs/heads/old ${ZERO_SHA}\n` +
      `refs/heads/new-feature ${REAL_SHA} refs/heads/new-feature ${ZERO_SHA}\n`;
    const r = runHook(stdin);
    const combined = r.stdout + r.stderr;
    // The all-deletion early-exit must NOT have fired.
    expect(combined).not.toContain("skipping validate");
    // The script should have reached the validate block, which logs
    // "pre-push: running validate + tests..." right before invoking npm.
    // (If npm fails because we're not in a npm context the test still
    // proves the script got that far -- the message is what we want.)
    expect(combined).toContain("running validate");
  });
});

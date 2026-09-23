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
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const HOOK_PATH = join(__dirname, "..", "..", ".githooks", "pre-push");

const ZERO_SHA = "0000000000000000000000000000000000000000";
const REAL_SHA = "abcdef1234567890abcdef1234567890abcdef12"; // arbitrary non-zero

const REPO_ROOT = join(__dirname, "..", "..");

// The hook uses whatever `node` is first on PATH; put this test's own Node
// there so its version check sees the Node running the suite.
const PATH_WITH_THIS_NODE = [dirname(process.execPath), process.env.PATH].join(delimiter);

// Stub `npm` and `npx`, first on every run's PATH: the hook's validate and test
// steps print what they would have run and succeed at once. The tests assert the
// hook's control flow; they must not run a real validate. They used to, and
// spawnSync's timeout killed bash but left that validate running as an orphan
// during every pre-push and CI unit run (QUA-16).
const STUB_BIN = (() => {
  const dir = mkdtempSync(join(tmpdir(), "stub-npm-"));
  for (const tool of ["npm", "npx"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\necho "stub ${tool} $*"\nexit 0\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  return dir;
})();

function runHook(
  stdin: string,
  path: string = PATH_WITH_THIS_NODE,
): { code: number; stdout: string; stderr: string } {
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
    env: { ...process.env, PATH: [STUB_BIN, path].join(delimiter) },
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
    // Mix: one deletion, one normal push to a feature branch. The hook must
    // NOT take the all-deletion early-exit: it runs validate, then the unit
    // tests (stubbed above), in that order, and passes.
    const stdin =
      `refs/heads/old ${ZERO_SHA} refs/heads/old ${ZERO_SHA}\n` +
      `refs/heads/new-feature ${REAL_SHA} refs/heads/new-feature ${ZERO_SHA}\n`;
    const r = runHook(stdin);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("skipping validate");
    const validate = combined.indexOf("stub npm run validate");
    const tests = combined.indexOf("stub npx jest --selectProjects unit");
    expect(validate).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(validate);
    expect(combined).toContain("pre-push: all checks passed.");
    expect(r.code).toBe(0);
  });
});

// 2026-09-23: #190's test passed pre-push on this shell's default Node 20 and
// failed CI on 24. The hook now refuses a Node older than app/package.json
// "engines" before running anything.
describe("pre-push hook — Node version", () => {
  /** A `node` that reports `version` and passes every other call to the real one. */
  function fakeNodeOnPath(version: string, opts: { failEval?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "fake-node-"));
    const script = [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
      opts.failEval ? 'if [ "$1" = "-p" ]; then exit 1; fi' : "",
      `exec "${process.execPath}" "$@"`,
    ].join("\n");
    writeFileSync(join(dir, "node"), script);
    chmodSync(join(dir, "node"), 0o755);
    return [dir, process.env.PATH].join(delimiter);
  }
  const push = `refs/heads/new-feature ${REAL_SHA} refs/heads/new-feature ${ZERO_SHA}\n`;

  it("refuses a Node older than engines, before validate runs", () => {
    const r = runHook(push, fakeNodeOnPath("v20.20.2"));
    const combined = r.stdout + r.stderr;
    expect(r.code).toBe(1);
    expect(combined).toContain("Node 20");
    expect(combined).toContain("engines.node needs >= 24");
    expect(combined).not.toContain("running validate");
  });

  it("refuses when the Node version cannot be read", () => {
    const r = runHook(push, fakeNodeOnPath("not-a-version"));
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("is not the Node this repo runs");
  });

  it("refuses when engines cannot be read", () => {
    const r = runHook(push, fakeNodeOnPath("v24.18.0", { failEval: true }));
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("needs >= ?");
  });

  it("goes on to validate on a Node that meets engines", () => {
    const r = runHook(push, fakeNodeOnPath("v24.18.0"));
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("is not the Node this repo runs");
    expect(combined).toContain("stub npm run validate");
    expect(r.code).toBe(0);
  });
});

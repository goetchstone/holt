// /app/__tests__/sessionStartHook.test.ts
//
// Behavior tests for `.claude/hooks/session-start-check.sh`, the home of rule
// 65's "a gate's failure reaches someone". Runs the actual shell script against
// a stub `gh` and `git`, and asserts on its exit code and its stdout.
//
// Why stdout: a SessionStart hook's stderr is written to the transcript file and
// delivered to nobody. Everything this hook printed went to stderr until
// 2026-11-05, so its warnings had never reached a session.
//
// Why these cases: Dependabot's update job failed 16 of its 42 runs on main, once
// with a green run landing minutes after it, and 17 high CodeQL alerts sat in the
// Security tab, 11 of them landing while the PR's own CodeQL check passed. Nothing
// said so.
//
// The stub answers with what `gh --jq` would print, so the branching in the hook
// runs for real and the `--jq` expressions don't. The PR that added this ran
// them against the real API.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const HOOK_SOURCE = join(__dirname, "..", "..", ".claude", "hooks", "session-start-check.sh");

// workflow, conclusion, event, day, run id: newest first, as `gh run list` lists.
const row = (name: string, conclusion: string, event: string, day: string, id: number) =>
  [name, conclusion, event, day, id].join("\t");

const GREEN_RUNS = [
  row("CI", "success", "push", "2026-11-05", 105),
  row("Security", "success", "push", "2026-11-05", 104),
];

interface World {
  /** Lines `gh run list` prints; null makes it fail. */
  runs?: string[] | null;
  /** What each alert endpoint prints; null makes it fail with its error body. */
  codeql?: string | null;
  dependabot?: string | null;
  /** The owner in `origin`, and the only account whose token can read alerts. */
  ownerOnlyAlerts?: string;
  /** Contents of app/osv-scanner.toml. */
  osvToml?: string;
}

function runHook(world: World) {
  const root = mkdtempSync(join(tmpdir(), "session-start-"));
  const hooks = join(root, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "session-start-check.sh"), readFileSync(HOOK_SOURCE));

  if (world.osvToml !== undefined) {
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "osv-scanner.toml"), world.osvToml);
  }

  const answers = mkdtempSync(join(tmpdir(), "gh-answers-"));
  const runs = world.runs === undefined ? GREEN_RUNS : world.runs;
  if (runs) writeFileSync(join(answers, "runs"), runs.join("\n") + "\n");
  const refused = '{"message":"You are not authorized to read alerts."}\n';
  const alert = (value: string | null | undefined) =>
    value === null ? refused : (value ?? "0") + "\n";
  writeFileSync(join(answers, "code-scanning"), alert(world.codeql));
  writeFileSync(join(answers, "dependabot"), alert(world.dependabot));

  const stub = mkdtempSync(join(tmpdir(), "stub-bin-"));

  // A stub `git` too: no real git runs in this file. Under a git hook the
  // environment carries GIT_DIR, so a real `git init` here targets the repository
  // being pushed. On 2026-11-05 it set core.bare in the shared .git/config during
  // a pre-push, and git refused work-tree commands in every worktree.
  const origin = world.ownerOnlyAlerts
    ? `echo git@github.com-work:${world.ownerOnlyAlerts}/widgets.git`
    : "exit 1";
  writeFileSync(
    join(stub, "git"),
    `#!/bin/sh
case "$*" in
  "remote get-url origin") ${origin} ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(stub, "git"), 0o755);

  const failOn = (value: string | null | undefined) => (value === null ? "exit 1" : "exit 0");
  writeFileSync(
    join(stub, "gh"),
    `#!/bin/sh
echo "$*" >> "${answers}/calls"
case "$*" in
  "auth token --user ${world.ownerOnlyAlerts ?? "nobody"}") echo owner-token; exit 0 ;;
  "auth token"*) exit 1 ;;
  "run list"*) cat "${answers}/runs" 2>/dev/null || exit 1 ;;
  *code-scanning*)
    ${world.ownerOnlyAlerts ? `[ "$GH_TOKEN" = owner-token ] || { echo '${refused.trim()}'; exit 1; }` : ""}
    cat "${answers}/code-scanning"; ${failOn(world.codeql)} ;;
  *dependabot*)
    ${world.ownerOnlyAlerts ? `[ "$GH_TOKEN" = owner-token ] || { echo '${refused.trim()}'; exit 1; }` : ""}
    cat "${answers}/dependabot"; ${failOn(world.dependabot)} ;;
esac
`,
  );
  chmodSync(join(stub, "gh"), 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [stub, process.env.PATH].join(delimiter),
  };
  delete env.GH_TOKEN;

  const result = spawnSync("bash", [join(hooks, "session-start-check.sh")], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: readFileSync(join(answers, "calls"), "utf8"),
  };
}

describe("session-start-check.sh: the gates on main reach the session", () => {
  it("says so on stdout when everything is green, so silence never means anything", () => {
    const { status, stdout } = runHook({});
    expect(status).toBe(0);
    expect(stdout).toMatch(/Gates on main \(rule 65\): green\. 2 runs since \d{4}-\d{2}-\d{2}/);
    expect(stdout).not.toContain("RED");
    expect(stdout).not.toContain("UNREAD");
  });

  it("reads a week of main's runs", () => {
    const { calls } = runHook({});
    expect(calls).toMatch(/run list --branch main --created >=\d{4}-\d{2}-\d{2} /);
  });

  it("names a pushed workflow whose last run failed", () => {
    const { status, stdout } = runHook({
      runs: [
        row("CI", "failure", "push", "2026-11-01", 201),
        row("CI", "success", "push", "2026-10-31", 200),
        row("Security", "success", "push", "2026-11-01", 199),
      ],
    });
    expect(status).toBe(0);
    expect(stdout).toContain("not all green");
    expect(stdout).toContain("RED: CI: its last run on main failed, 2026-11-01 (run 201).");
    expect(stdout).not.toContain("RED: Security");
  });

  it("lets a pushed workflow recover: an older failure under a green run is not red", () => {
    const { stdout } = runHook({
      runs: [
        row("CI", "success", "push", "2026-11-02", 202),
        row("CI", "failure", "push", "2026-11-01", 201),
      ],
    });
    expect(stdout).toContain("(rule 65): green");
    expect(stdout).not.toContain("RED");
  });

  it("does not let a passing Dependabot job hide the failed one beside it", () => {
    const { stdout } = runHook({
      runs: [
        row("Dependabot Updates", "success", "dynamic", "2026-11-02", 303),
        row("Dependabot Updates", "failure", "dynamic", "2026-11-02", 302),
        row("Dependabot Updates", "success", "dynamic", "2026-11-02", 301),
      ],
    });
    expect(stdout).toMatch(
      /RED: Dependabot Updates: 1 of 3 runs failed since \S+, last on 2026-11-02 \(run 302\)\./,
    );
  });

  it("takes a cancelled or unfinished run as saying nothing", () => {
    const { stdout } = runHook({
      runs: [
        row("CI", "", "push", "2026-11-03", 402),
        row("CI", "cancelled", "push", "2026-11-03", 401),
        row("CI", "failure", "push", "2026-11-02", 400),
        row("Security", "cancelled", "push", "2026-11-03", 399),
        row("Security", "success", "push", "2026-11-02", 398),
      ],
    });
    expect(stdout).toContain("RED: CI: its last run on main failed, 2026-11-02 (run 400).");
    expect(stdout).not.toContain("RED: Security");
  });

  it("counts open alerts, which no PR's green check will ever mention", () => {
    const { stdout } = runHook({ codeql: "17", dependabot: "2" });
    expect(stdout).toContain("not all green");
    expect(stdout).toContain("RED: CodeQL alerts open on main: 17.");
    expect(stdout).toContain("RED: Dependabot alerts open on main: 2.");
  });

  it("says UNREAD, never green, when gh is refused the alerts", () => {
    const { status, stdout } = runHook({ codeql: null, dependabot: null });
    expect(status).toBe(0);
    expect(stdout).not.toContain("(rule 65): green");
    expect(stdout).toContain("UNREAD: CodeQL alerts");
    expect(stdout).toContain("UNREAD: Dependabot alerts");
  });

  it("says UNREAD, never green, when no runs can be read", () => {
    const { status, stdout } = runHook({ runs: null });
    expect(status).toBe(0);
    expect(stdout).not.toContain("(rule 65): green");
    expect(stdout).toContain("UNREAD: no workflow runs on main read");
  });

  it("reads alerts as the account that owns the repository, not the active one", () => {
    const { stdout } = runHook({ ownerOnlyAlerts: "acme", codeql: "3" });
    expect(stdout).toContain("RED: CodeQL alerts open on main: 3.");
    expect(stdout).not.toContain("UNREAD");
  });

  it("puts an expired CVE suppression on stdout, and keeps a current one quiet", () => {
    const expired = runHook({ osvToml: "ignoreUntil = 2020-01-02\nignoreUntil = 2999-01-01\n" });
    expect(expired.stdout).toContain("expired CVE suppression");
    expect(expired.stdout).toContain("- 2020-01-02");
    expect(expired.stdout).not.toContain("2999-01-01");

    const current = runHook({ osvToml: "ignoreUntil = 2999-01-01\n" });
    expect(current.stdout).not.toContain("expired CVE suppression");
  });
});

// /app/__tests__/domainMapCoverage.test.ts
//
// Rule 65 for `.claude/hooks/domain-map.txt`, the manifest the pre-PR doc gate
// reads to know which runbook a source file belongs to. A file that matches no
// line is never asked for its runbook, so the gate is only as wide as the map:
// on 2026-11-18, 745 of 1,803 source files matched nothing, among them
// lib/pricing, lib/inventory, lib/sales, lib/purchasing and server/trpc.
//
// Fails in both directions: a source file no line covers, and a line that
// covers no file or names a runbook that does not exist. A line whose runbook is
// `-` says the files have no runbook of their own, and must say why.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SOURCE = /^app\/src\/(app|pages|lib|components|server)\//;

interface MapLine {
  line: number;
  pattern: string;
  runbook: string;
  reason: string;
  regex: RegExp;
}

/** The map as doc-gate.sh reads it: `*` matches anything, across directories. */
function readMap(): MapLine[] {
  const text = readFileSync(join(ROOT, ".claude/hooks/domain-map.txt"), "utf8");
  return text.split("\n").flatMap((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith("#")) return [];
    const [pattern = "", runbook = "", reason = ""] = l.split("|");
    const body = pattern
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return [
      { line: i + 1, pattern, runbook, reason: reason.trim(), regex: new RegExp(`^${body}$`) },
    ];
  });
}

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "app/src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => SOURCE.test(f));
}

const map = readMap();
const files = sourceFiles();

describe("domain-map.txt covers every source file (rule 65)", () => {
  it("lists source files to check", () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it("every source file matches a line", () => {
    const uncovered = files.filter((f) => !map.some((m) => m.regex.test(f)));
    expect(uncovered).toEqual([]);
  });

  it("every line matches a tracked file", () => {
    const stale = map
      .filter((m) => !files.some((f) => m.regex.test(f)))
      .map((m) => `${m.line}: ${m.pattern}`);
    expect(stale).toEqual([]);
  });

  it("every runbook exists, and every `-` line gives a reason", () => {
    const bad = map
      .filter((m) =>
        m.runbook === "-" ? m.reason.length < 10 : !existsSync(join(ROOT, m.runbook)),
      )
      .map((m) => `${m.line}: ${m.pattern}|${m.runbook}|${m.reason}`);
    expect(bad).toEqual([]);
  });
});

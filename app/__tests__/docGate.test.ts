// /app/__tests__/docGate.test.ts
//
// Behaviour of `.claude/hooks/doc-gate.sh`, the runbook half of the pre-PR gate
// (CLAUDE.md rules 19 and 36). Runs the real script against a small map and
// made-up branches. The old gate passed any branch that touched any file under
// docs/, so a pricing change with a typo fix in an unrelated runbook went
// through, and it did not count app/src/server (tRPC) as code at all.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "..", ".claude", "hooks", "doc-gate.sh");

const MAP = join(mkdtempSync(join(tmpdir(), "docgate-")), "domain-map.txt");
writeFileSync(
  MAP,
  [
    "# comment",
    "app/src/lib/pricing/special.ts|docs/domains/special.md",
    "app/src/lib/pricing/*|docs/domains/pricing-catalog.md",
    "app/src/server/trpc/routers/reports.ts|docs/domains/reporting.md",
    "app/src/components/ui/*|-|shared UI primitives",
    "",
  ].join("\n"),
);

function gate(changed: string[], codeLines = 50, commits = "a commit"): number | null {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOC_GATE_CHANGED: changed.join("\n"),
      DOC_GATE_CODE_LINES: String(codeLines),
      DOC_GATE_COMMITS: commits,
      DOC_GATE_MAP: MAP,
    },
    timeout: 20000,
  });
  return r.status;
}

const PASS = 0;
const BLOCK = 2;

describe("doc-gate.sh", () => {
  it("passes a branch with no source change, or 20 lines or fewer", () => {
    expect(gate(["docs/x.md", "app/__tests__/a.test.ts"])).toBe(PASS);
    expect(gate(["app/src/lib/pricing/a.ts"], 20)).toBe(PASS);
  });

  it("requires the mapped runbook, not just any doc", () => {
    expect(gate(["app/src/lib/pricing/a.ts"])).toBe(BLOCK);
    expect(gate(["app/src/lib/pricing/a.ts", "docs/domains/reporting.md"])).toBe(BLOCK);
    expect(gate(["app/src/lib/pricing/a.ts", "docs/domains/pricing-catalog.md"])).toBe(PASS);
  });

  it("requires every runbook the branch's files map to", () => {
    const code = ["app/src/lib/pricing/a.ts", "app/src/server/trpc/routers/reports.ts"];
    expect(gate([...code, "docs/domains/pricing-catalog.md"])).toBe(BLOCK);
    expect(gate([...code, "docs/domains/pricing-catalog.md", "docs/domains/reporting.md"])).toBe(
      PASS,
    );
  });

  it("uses the first matching line", () => {
    expect(gate(["app/src/lib/pricing/special.ts", "docs/domains/pricing-catalog.md"])).toBe(BLOCK);
    expect(gate(["app/src/lib/pricing/special.ts", "docs/domains/special.md"])).toBe(PASS);
  });

  it("counts app/src/server as code", () => {
    expect(gate(["app/src/server/trpc/routers/reports.ts"])).toBe(BLOCK);
  });

  it("asks a `-` or unmapped file for some doc", () => {
    expect(gate(["app/src/components/ui/Button.tsx"])).toBe(BLOCK);
    expect(gate(["app/src/components/ui/Button.tsx", "docs/ARCHITECTURE.md"])).toBe(PASS);
    expect(gate(["app/src/lib/elsewhere.ts", "CLAUDE.md"])).toBe(PASS);
  });

  it("is waived by docs-not-needed in a commit message", () => {
    expect(gate(["app/src/lib/pricing/a.ts"], 50, "fix\n\ndocs-not-needed: rename only")).toBe(
      PASS,
    );
  });
});

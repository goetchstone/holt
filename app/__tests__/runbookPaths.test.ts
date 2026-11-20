// /app/__tests__/runbookPaths.test.ts
//
// Rule 19 says a runbook is pinned against source; a path to a file that no
// longer exists is the cheapest way for one to drift, and the reader who
// follows it learns nothing about where the code went. On 2026-11-18 the
// runbooks cited 47 such paths (the reports REST routes moved to tRPC, pages
// moved to the App Router, `lib/importRunners.ts` was split).
//
// Every backticked file path in docs/domains/*.md must exist, read from the
// repo root, from app/, or from app/src/. A path kept on purpose (history: the
// file was removed, and the sentence says so) is listed in
// fixtures/runbook-dead-paths.txt with a reason. The check fails in both
// directions: a dead path not listed, and a listed path that now resolves or
// is no longer cited.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const DOMAINS = join(ROOT, "docs", "domains");
const ALLOW = join(__dirname, "fixtures", "runbook-dead-paths.txt");

const SPAN = /`([^`\s]+)`/g;
const PATH =
  /^(?:app\/)?(?:src|__tests__|prisma|scripts|docs|config|\.claude|lib|components|server|pages)\/[\w.()[\]/@-]+\.(?:ts|tsx|js|mjs|cjs|sh|md|sql|json|prisma|txt|yml|yaml|css)$/;

/** `runbook|path` for every cited path, once per runbook. */
function citedPaths(): Map<string, boolean> {
  const cited = new Map<string, boolean>();
  for (const name of readdirSync(DOMAINS).filter((n) => n.endsWith(".md"))) {
    const text = readFileSync(join(DOMAINS, name), "utf8");
    for (const [, span] of text.matchAll(SPAN)) {
      const path = span.split(":")[0].replace(/[.,]+$/, "");
      if (path.includes("*") || !PATH.test(path)) continue;
      const exists = [path, `app/${path}`, `app/src/${path}`].some((p) =>
        existsSync(join(ROOT, p)),
      );
      cited.set(`${name}|${path}`, exists);
    }
  }
  return cited;
}

function allowed(): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of readFileSync(ALLOW, "utf8").split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const [runbook = "", path = "", reason = ""] = l.split("|");
    out.set(`${runbook}|${path}`, reason.trim());
  }
  return out;
}

const cited = citedPaths();
const allow = allowed();

describe("runbook file paths resolve (rule 19)", () => {
  it("finds paths to check", () => {
    expect(cited.size).toBeGreaterThan(500);
  });

  it("every cited path exists or is listed with a reason", () => {
    const dead = [...cited].filter(([k, ok]) => !ok && !allow.has(k)).map(([k]) => k);
    expect(dead).toEqual([]);
  });

  it("every listed path is still cited, still dead, and has a reason", () => {
    const stale = [...allow]
      .filter(([k, reason]) => cited.get(k) !== false || reason.length < 10)
      .map(([k]) => k);
    expect(stale).toEqual([]);
  });
});

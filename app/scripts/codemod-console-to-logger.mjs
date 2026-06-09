// app/scripts/codemod-console-to-logger.mjs
//
// One-shot codemod: replace console.error/warn/log with the structured logger
// in API routes (CLAUDE.md rule 7). Conservative — only rewrites the safe,
// uniform shapes and reports anything it skips so the remainder can be done by
// hand. Scoped to src/pages/api by default (pass a dir arg to override).
//
// Run: node scripts/codemod-console-to-logger.mjs [--dry]

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DRY = process.argv.includes("--dry");
const ROOT = process.argv.find((a) => a.startsWith("src/")) || "src/pages/api";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// Strip a single trailing colon (and trailing spaces) from a quoted/backticked
// message literal so "Failed to X:" becomes "Failed to X".
function trimColon(literal) {
  const quote = literal[0];
  const inner = literal.slice(1, -1).replace(/:\s*$/, "");
  return `${quote}${inner}${quote}`;
}

let filesChanged = 0;
let callsRewritten = 0;
const skipped = [];

for (const file of walk(ROOT)) {
  let src = readFileSync(file, "utf8");
  if (!/console\.(error|warn|log)/.test(src)) continue;

  const original = src;
  let usesLogError = false;
  let usesLogger = false;

  // console.error("msg", err)  |  console.error(`msg`, err)  -> logError("msg", err)
  src = src.replace(
    /console\.error\((["'`][^"'`]*["'`]),\s*([^);]+)\)/g,
    (_m, lit, errExpr) => {
      usesLogError = true;
      callsRewritten++;
      return `logError(${trimColon(lit)}, ${errExpr.trim()})`;
    },
  );

  // console.error(singleIdentifier)  -> logError("Unexpected error", err)
  src = src.replace(/console\.error\(([a-zA-Z_$][\w$.?]*)\)/g, (_m, expr) => {
    usesLogError = true;
    callsRewritten++;
    return `logError("Unexpected error", ${expr})`;
  });

  // console.warn(...) -> logger.warn(...) ; console.log(...) -> logger.info(...)
  src = src.replace(/console\.warn\(/g, () => {
    usesLogger = true;
    callsRewritten++;
    return "logger.warn(";
  });
  src = src.replace(/console\.log\(/g, () => {
    usesLogger = true;
    callsRewritten++;
    return "logger.info(";
  });

  // Anything left is an unhandled shape (e.g. console.error("msg", a, b)).
  const leftover = src.match(/console\.(error|warn|log)\(/g);
  if (leftover) skipped.push(`${file}: ${leftover.length} unhandled`);

  if (src === original) continue;

  // Ensure the logger import exists with the symbols we used.
  const needed = [];
  if (usesLogError && !/\blogError\b/.test(original)) needed.push("logError");
  if (usesLogger && !/\blogger\b/.test(original.replace(/console\./g, ""))) needed.push("logger");

  if (needed.length > 0) {
    const importLine = `import { ${needed.join(", ")} } from "@/lib/logger";\n`;
    // Insert after the last existing top-of-file import statement.
    const importRe = /^import .*;$/gm;
    let lastImportEnd = -1;
    let m;
    while ((m = importRe.exec(src)) !== null) lastImportEnd = m.index + m[0].length;
    if (lastImportEnd >= 0) {
      src = src.slice(0, lastImportEnd) + "\n" + importLine.trimEnd() + src.slice(lastImportEnd);
    } else {
      src = importLine + src;
    }
  }

  filesChanged++;
  if (!DRY) writeFileSync(file, src, "utf8");
}

console.log(`${DRY ? "[DRY] " : ""}files changed: ${filesChanged}, calls rewritten: ${callsRewritten}`);
if (skipped.length) {
  console.log(`SKIPPED (manual follow-up needed):`);
  for (const s of skipped) console.log("  " + s);
}

// /app/__tests__/permissionKeysExist.test.ts
//
// Every key a route gates on is a key the owner can actually grant. A typo in
// requirePermission("sales.raed", ...) compiles, loads and then denies everyone
// but the bootstrap safeguard, and no test that never imports that route would
// notice. This reads every requirePermission( call under src -- one key or an
// { anyOf: [...] } list -- and checks each literal against the catalog, the
// list Admin > Roles offers.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { isPermissionKey } from "@/lib/auth/permissionCatalog";

const APP_DIR = join(__dirname, "..");
const SRC_DIR = join(APP_DIR, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The first argument of each requirePermission( call, or null where it is
 *  not a literal key or an { anyOf } list of literals (so it cannot be checked). */
function firstArguments(source: string): Array<string | null> {
  const out: Array<string | null> = [];
  // The definition itself is `requirePermission(permission: ...`, not a call.
  const call = /(?<!function )requirePermission\(\s*/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source))) {
    const rest = source.slice(match.index + match[0].length);
    // Prose names the function as `requirePermission()`; a call has an argument.
    if (rest.startsWith(")")) continue;
    // One key, or { anyOf: [ ...literals... ] } -- Prettier may break the list
    // over lines and leave a trailing comma after the "]".
    const literal =
      /^"[^"]*"/.exec(rest) ?? /^\{\s*anyOf:\s*\[(\s*"[^"]*"\s*,?)*\s*\]\s*,?\s*\}/.exec(rest);
    out.push(literal ? literal[0] : null);
  }
  return out;
}

const calls = sourceFiles(SRC_DIR).flatMap((file) =>
  firstArguments(readFileSync(file, "utf8")).map((arg) => ({
    file: relative(APP_DIR, file),
    arg,
  })),
);
const parsed = calls.filter((c): c is { file: string; arg: string } => c.arg !== null);

describe("requirePermission gates on keys the catalog defines", () => {
  it("finds the calls it is meant to check", () => {
    // A floor, so a broken pattern that matches nothing cannot pass silently.
    expect(calls.length).toBeGreaterThan(300);
  });

  it("every first argument is a literal key or an { anyOf } list of literals", () => {
    const notLiteral = calls.filter(({ arg }) => arg === null).map(({ file }) => file);
    expect(notLiteral).toEqual([]);
  });

  it("every key named is in the permission catalog", () => {
    const unknown = parsed.flatMap(({ file, arg }) =>
      [...arg.matchAll(/"([^"]*)"/g)]
        .map((m) => m[1])
        .filter((key) => !isPermissionKey(key))
        .map((key) => `${file}: "${key}"`),
    );
    expect(unknown).toEqual([]);
  });

  it("no { anyOf } list is empty", () => {
    const empty = parsed.filter(({ arg }) => /^\{\s*anyOf:\s*\[\s*\]/.test(arg));
    expect(empty).toEqual([]);
  });
});

// /app/__tests__/api500Bodies.test.ts
//
// A 500 says what failed, never why. The why -- a Prisma error's model,
// column and constraint names, a stack -- goes to logError, where the
// operator can read it, not into the response, where anyone who can reach
// the route can. QUA-04 found 37 sites in 32 route files putting
// getErrorMessage(err) into a 500 body, two of them public
// (services/public, bookings/availability); four logged nothing at all, so
// the response was the only record.
//
// The first version read only the text inside `.status(500).json(...)`, so a
// route that wrote `const message = err instanceof Error ? err.message : "x"`
// one line up and answered `.json({ error: message })` passed. Route files did
// exactly that until 2026-11 (the 2026-11-18 health audit's leftovers). Each
// route is now parsed with the TypeScript parser, and a 500 body leaks when it
// reaches an error's message or stack, getErrorMessage(...), or the caught
// error itself -- directly, or through the names it is built from, followed to
// their declarations and every write to them in the same file: an assignment to
// the name or to a property under it (`results.error = ...`), x.push(...) and
// its kin, and Object.assign(x, ...). The caught error is a catch clause's, or
// the one a promise hands its rejection handler (`.catch((e) => ...)`,
// `.then(ok, (e) => ...)`). A status that can be 500 counts, not only the
// literal: `res.status(known ? 409 : 500)` is a 500 when it isn't known.
// diagnostics/lookup-test.ts wrote getErrorMessage(error) into a field of its
// result object and answered the object; the version before writes were
// followed passed it (2026-11-21).
//
// What it cannot see, so don't lean on it there: a value built in another
// module (the automation trigger routes answer a failed run with a 500 and its
// run log, whose errors are the phases' own messages), internals that are not
// an error's (admin/database/restore.ts answers psql's stderr as `details` in
// its 500s), the error of a callback that is not a promise's (`form.parse(req,
// (err) => ...)`), a status an error carries (`res.status(err.status)`: no error
// class carries a 5xx today), and a body handed to a function that sends it.
//
// 4xx bodies stay informative: they describe the caller's mistake. This
// guard is only for 500s.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const API = join(__dirname, "..", "src", "pages", "api");
/** The first version's check on the body's own text, kept so nothing it caught slips. */
const LEAKS = /getErrorMessage\(|\.message\b|\bstack\b/;
const SENDERS = new Set(["json", "send", "end"]);
const ERROR_PARTS = new Set(["message", "stack"]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function parse(fileName: string, text: string): ts.SourceFile {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

/** Whether a binding (a name, or a destructuring pattern) declares `name`. */
function binds(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((el) => !ts.isOmittedExpression(el) && binds(el.name, name));
}

/** The name an expression's value is reached through: `x` for x, x.a, x["a"].b, (x as T).a. */
function rootName(expr: ts.Expression): string | undefined {
  let node: ts.Expression = expr;
  while (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node.text : undefined;
}

/** Calls that put their arguments into the object or list they are called on. */
const WRITERS = new Set(["push", "unshift", "splice", "set", "add"]);

/**
 * What every write to `name` inside `scope` puts into its value: the right-hand
 * side of an assignment to the name or to a property under it (x = v, x.a = v,
 * x["a"].b += v), the arguments of x.push(v) and its kin, and every source of
 * Object.assign(x, ...sources).
 */
function assignmentsIn(scope: ts.Node, name: string): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      rootName(node.left) === name
    ) {
      out.push(node.right);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: target, name: method } = node.expression;
      if (WRITERS.has(method.text) && rootName(target) === name) {
        out.push(...node.arguments);
      } else if (
        method.text === "assign" &&
        ts.isIdentifier(target) &&
        target.text === "Object" &&
        node.arguments.length > 0 &&
        rootName(node.arguments[0]) === name
      ) {
        out.push(...node.arguments.slice(1));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return out;
}

/**
 * Whether `fn` is a promise's rejection handler -- `p.catch(fn)` or
 * `p.then(onFulfilled, fn)` -- whose error `name` is: the same error a catch
 * clause holds, handed over as a parameter.
 */
function isRejectionHandler(fn: ts.SignatureDeclaration, name: string): boolean {
  const [error] = fn.parameters;
  if (!error || !binds(error.name, name)) return false;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  return (
    (method === "catch" && call.arguments[0] === fn) ||
    (method === "then" && call.arguments[1] === fn)
  );
}

/** The `const`/`let`/`var` declaration of `name` among `scope`'s own statements. */
function declarationIn(scope: ts.Node, name: string): ts.VariableDeclaration | undefined {
  const blockLike =
    ts.isBlock(scope) ||
    ts.isSourceFile(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope);
  if (!blockLike) return undefined;
  for (const statement of scope.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const found = statement.declarationList.declarations.find((d) => binds(d.name, name));
    if (found) return found;
  }
  return undefined;
}

/**
 * What a name's value is made from: its initializer and every write to it, in
 * the nearest scope that declares it. "caught" for a catch clause's error, and
 * for the error a promise hands its rejection handler; nothing for any other
 * parameter, an import or a global, which this file can't see into.
 */
function sourcesOf(id: ts.Identifier): (ts.Expression | "caught")[] {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      if (binds(scope.variableDeclaration.name, id.text)) return ["caught"];
    }
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => binds(p.name, id.text))) {
      return isRejectionHandler(scope, id.text) ? ["caught"] : [];
    }
    const declared = declarationIn(scope, id.text);
    if (declared) {
      const initial = declared.initializer ? [declared.initializer] : [];
      return [...initial, ...assignmentsIn(scope, id.text)];
    }
  }
  return [];
}

/**
 * Whether `root`, or any value it is built from in this file, satisfies `hit`.
 * Property names and types are not values; a name is followed to its sources.
 * `caught` says whether reaching the caught error itself counts.
 */
function reaches(root: ts.Node, hit: (node: ts.Node) => boolean, caught: boolean): boolean {
  const seen = new Set<ts.Node>();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isTypeNode(node)) return;
    if (hit(node)) {
      found = true;
    } else if (ts.isIdentifier(node)) {
      for (const source of sourcesOf(node)) {
        if (source === "caught") found ||= caught;
        else if (!seen.has(source)) {
          seen.add(source);
          visit(source);
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
    } else if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name);
      visit(node.initializer);
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(root);
  return found;
}

/** An error's message or stack, or getErrorMessage(...). */
function isLeak(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return ERROR_PARTS.has(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return ts.isStringLiteralLike(key) && ERROR_PARTS.has(key.text);
  }
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "getErrorMessage"
  );
}

const isFiveHundred = (node: ts.Node): boolean => ts.isNumericLiteral(node) && node.text === "500";

/** The argument of every `.status(S).json(...)` (or `.send`, `.end`) whose S can be 500. */
function fiveHundredBodies(sf: ts.SourceFile): { line: number; body: ts.Expression }[] {
  const out: { line: number; body: ts.Expression }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      SENDERS.has(node.expression.name.text) &&
      node.arguments.length > 0
    ) {
      const target = node.expression.expression;
      if (
        ts.isCallExpression(target) &&
        ts.isPropertyAccessExpression(target.expression) &&
        target.expression.name.text === "status" &&
        target.arguments.length === 1 &&
        reaches(target.arguments[0], isFiveHundred, false)
      ) {
        const status = target.arguments[0];
        const line = sf.getLineAndCharacterOfPosition(status.getStart(sf)).line + 1;
        out.push({ line, body: node.arguments[0] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The 500 bodies in `sf` that carry an error's internals, as `line  body`. */
function leakingBodies(sf: ts.SourceFile): string[] {
  return fiveHundredBodies(sf)
    .filter(({ body }) => LEAKS.test(body.getText(sf)) || reaches(body, isLeak, true))
    .map(({ line, body }) => `${line}  ${body.getText(sf).replace(/\s+/g, " ")}`);
}

/** One handler around `catchClause`, parsed as a route would be. */
function handlerWith(catchClause: string): ts.SourceFile {
  return parse("fixture.ts", `async function h(req, res) { try { await work(); } ${catchClause} }`);
}

/** One handler whose body is `body`, parsed as a route would be. */
function handlerOf(body: string): ts.SourceFile {
  return parse("fixture.ts", `async function h(req, res) { ${body} }`);
}

describe("API 500 responses carry no error internals", () => {
  it("finds the 500 bodies it guards (the scan is not vacuous)", () => {
    const count = routeFiles(API).reduce(
      (n, file) => n + fiveHundredBodies(parse(file, readFileSync(file, "utf8"))).length,
      0,
    );
    expect(count).toBeGreaterThan(100);
  });

  it.each([
    [
      "a name declared from the message",
      `catch (err) { const message = err instanceof Error ? err.message : "x"; return res.status(500).json({ error: message }); }`,
    ],
    [
      "a name assigned later",
      `catch (e) { let why = "x"; why = getErrorMessage(e, "y"); res.status(500).json({ error: "Failed", details: why }); }`,
    ],
    [
      "a template and a shorthand property",
      `catch (err) { const msg = String(err); return res.status(500).json({ error: \`Failed: \${msg}\`, msg }); }`,
    ],
    [
      "a destructured message",
      `catch (err) { const { message } = err as Error; return res.status(500).send(message); }`,
    ],
    [
      "a status that can be 500",
      `catch (err) { const m = (err as Error).message; return res.status(m.includes("x") ? 409 : 500).json({ error: m }); }`,
    ],
    [
      "the caught error itself",
      `catch (err) { return res.status(500).json({ error: "Failed", cause: err }); }`,
    ],
    [
      "a write to a property of the body",
      `catch (err) { const body = { error: "Failed" }; body.detail = (err as Error).message; return res.status(500).json(body); }`,
    ],
    [
      "a write to a nested or computed property of the body",
      `catch (err) { const body: any = { meta: {} }; body.meta["why"] = String(err); return res.status(500).json(body); }`,
    ],
    [
      "an error pushed onto a list in the body",
      `catch (err) { const errors: string[] = []; errors.push(String(err)); return res.status(500).json({ errors }); }`,
    ],
    [
      "an error merged into the body with Object.assign",
      `catch (err) { const body = {}; Object.assign(body, { why: getErrorMessage(err, "x") }); return res.status(500).json(body); }`,
    ],
  ])("sees through %s", (_how, catchClause) => {
    expect(leakingBodies(handlerWith(catchClause))).toHaveLength(1);
  });

  it("sees an error written into a result object declared before the try", () => {
    // diagnostics/lookup-test.ts until 2026-11-21: the 500 body is the name alone.
    const route = handlerOf(
      `const results: any = { searchTerm: "x", error: null };
       try { results.found = await lookUp(); return res.status(200).json(results); }
       catch (error: unknown) {
         results.error = \`An unexpected database error occurred: \${getErrorMessage(error, "unknown error")}\`;
         return res.status(500).json(results);
       }`,
    );
    expect(leakingBodies(route)).toHaveLength(1);
  });

  it.each([
    [
      "a .catch callback's error",
      `return work().catch((e) => res.status(500).json({ error: String(e) }));`,
    ],
    [
      "a .catch callback's error, in a function",
      `return work().catch(function (e) { return res.status(500).json({ error: "Failed", cause: e }); });`,
    ],
    [
      "the rejection handler of .then",
      `return work().then((rows) => res.json(rows), (e) => res.status(500).json({ why: String(e) }));`,
    ],
  ])("sees an error passed to a promise callback: %s", (_how, body) => {
    expect(leakingBodies(handlerOf(body))).toHaveLength(1);
  });

  it.each([
    [
      "a .catch callback that logs and answers a fixed message",
      `return work().catch((e) => { logError("x failed", e); return res.status(500).json({ error: "Failed" }); });`,
    ],
    [
      "a fulfilled value, which is no error",
      `return work().then((rows) => res.status(500).json({ rows }));`,
    ],
    [
      "a fixed message written to the body",
      `try { await work(); } catch (err) { logError("x", err); const body = { error: "x" }; body.error = "Failed"; return res.status(500).json(body); }`,
    ],
  ])("passes %s", (_how, body) => {
    expect(leakingBodies(handlerOf(body))).toEqual([]);
  });

  it.each([
    [
      "a fixed message, the error logged",
      `catch (err) { logError("x failed", err); return res.status(500).json({ error: "Import failed" }); }`,
    ],
    [
      "the message in a 4xx",
      `catch (err) { const message = (err as Error).message; return res.status(400).json({ error: message }); }`,
    ],
    [
      "a property merely named message",
      `catch (err) { const message = "Couldn't save."; return res.status(500).json({ message }); }`,
    ],
  ])("passes %s", (_how, catchClause) => {
    expect(leakingBodies(handlerWith(catchClause))).toEqual([]);
  });

  it("no 500 body carries getErrorMessage, an error's message or stack, or the error", () => {
    const leaks = routeFiles(API).flatMap((file) =>
      leakingBodies(parse(file, readFileSync(file, "utf8"))).map(
        (leak) => `${relative(API, file)}:${leak}`,
      ),
    );
    expect(leaks).toEqual([]);
  });
});

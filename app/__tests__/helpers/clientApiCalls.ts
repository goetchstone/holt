// /app/__tests__/helpers/clientApiCalls.ts
//
// Reads client code and API routes with the TypeScript parser, so the tripwire in
// clientApiRoutes.test.ts can ask of every REST call on a screen: is there a route
// at that path, and does it answer that method? Pure functions of source text. It
// parses and never runs anything: no git, no database, no type checker.

import ts from "typescript";

/** Stands in for a `${...}` whose value isn't known until runtime. */
const UNKNOWN = "\u0000";
const AXIOS_VERBS = new Set(["get", "post", "put", "patch", "delete", "head"]);
/** axios members that send nothing. */
const AXIOS_HELPERS = new Set(["isAxiosError", "isCancel", "CancelToken", "AxiosError"]);
/** How many consistent readings of one call's conditions to follow before giving up. */
const MAX_WORLDS = 64;

export interface ApiRoute {
  file: string;
  /** Path below /api, e.g. ["customers", "[id]", "addresses"]. */
  segments: string[];
  /** The methods it answers, or "any" when it never looks at the method. */
  methods: ReadonlySet<string> | "any";
}

export interface ClientCall {
  file: string;
  line: number;
  /** The URL argument's source text, whitespace collapsed: the manifest's key. */
  expression: string;
  /** Upper-case verb, or null when the code doesn't say statically. */
  method: string | null;
  /** The path with each unknown `${...}` marked, or null when it can't be read. */
  url: string | null;
}

export type Verdict =
  | { status: "ok"; route: ApiRoute }
  | { status: "not-api" }
  | { status: "no-route"; path: string }
  | { status: "no-method"; path: string; route: ApiRoute }
  | { status: "unresolved"; why: string };

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function isEquality(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function segmentsOf(file: string): string[] {
  const segments = file
    .replace(/^src\/(pages|app)\/api\/?/, "")
    .replace(/\.tsx?$/, "")
    .split("/")
    .filter(Boolean);
  const last = segments.at(-1);
  if (last === "index" || (last === "route" && file.startsWith("src/app/"))) segments.pop();
  return segments;
}

/** An App Router route answers the methods it exports by name. */
function appRouterMethods(sf: ts.SourceFile): Set<string> {
  const methods = new Set<string>();
  const add = (name: string) => {
    if (/^[A-Z]+$/.test(name)) methods.add(name);
  };
  sf.forEachChild((n) => {
    const exported =
      ts.canHaveModifiers(n) &&
      ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
      n.exportClause.elements.forEach((el) => add(el.name.text));
    }
    if (!exported) return;
    if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text);
    if (ts.isVariableStatement(n)) {
      n.declarationList.declarations.forEach((d) => {
        if (ts.isIdentifier(d.name)) add(d.name.text);
      });
    }
  });
  return methods;
}

/**
 * `req.method === "POST"` says POST is answered. `req.method !== "GET"` says so only
 * when it guards a refusal: `if (req.method !== "GET") return 405`. Written as
 * `if (req.method !== "GET" && locked) return 409`, it's about every other method, and
 * the route may not answer GET at all.
 */
function isUnrelatedNegation(comparison: ts.BinaryExpression): boolean {
  const op = comparison.operatorToken.kind;
  if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
    return false;
  }
  let guard: ts.Node = comparison.parent;
  while (ts.isParenthesizedExpression(guard) || ts.isBinaryExpression(guard)) guard = guard.parent;
  if (!ts.isIfStatement(guard)) return true;
  return !/\b405\b|methodNotAllowed\(/.test(guard.thenStatement.getText());
}

/** A Pages Router route answers the methods it compares `req.method` with. */
function pagesRouterMethods(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const isRequest = (e: ts.Expression) => ts.isIdentifier(e) && /^_?req(uest)?$/.test(e.text);

  const collectAliases = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      // const { method } = req; const { method: verb } = req; const verb = req.method;
      if (ts.isObjectBindingPattern(n.name) && isRequest(n.initializer)) {
        for (const el of n.name.elements) {
          if ((el.propertyName ?? el.name).getText() === "method") aliases.add(el.name.getText());
        }
      }
      const init = n.initializer;
      if (
        ts.isIdentifier(n.name) &&
        ts.isPropertyAccessExpression(init) &&
        init.name.text === "method" &&
        isRequest(init.expression)
      ) {
        aliases.add(n.name.text);
      }
    }
    ts.forEachChild(n, collectAliases);
  };
  collectAliases(sf);

  const isMethod = (node: ts.Expression) => {
    const e = unwrap(node);
    if (ts.isIdentifier(e)) return aliases.has(e.text);
    return ts.isPropertyAccessExpression(e) && e.name.text === "method" && isRequest(e.expression);
  };

  const methods = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && isEquality(n.operatorToken.kind) && !isUnrelatedNegation(n)) {
      if (isMethod(n.left) && ts.isStringLiteralLike(n.right)) methods.add(n.right.text);
      if (isMethod(n.right) && ts.isStringLiteralLike(n.left)) methods.add(n.left.text);
    }
    if (ts.isSwitchStatement(n) && isMethod(n.expression)) {
      for (const clause of n.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
          methods.add(clause.expression.text);
        }
      }
    }
    // ["GET", "POST"].includes(req.method)
    if (
      ts.isCallExpression(n) &&
      n.arguments.length === 1 &&
      isMethod(n.arguments[0]) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "includes" &&
      ts.isArrayLiteralExpression(n.expression.expression)
    ) {
      for (const el of n.expression.expression.elements) {
        if (ts.isStringLiteralLike(el)) methods.add(el.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return methods;
}

export function parseRoute(file: string, source: string): ApiRoute {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = file.startsWith("src/app/") ? appRouterMethods(sf) : pagesRouterMethods(sf);
  return { file, segments: segmentsOf(file), methods: methods.size === 0 ? "any" : methods };
}

// ---------------------------------------------------------------------------
// Evaluating a URL or method expression
// ---------------------------------------------------------------------------

/**
 * One consistent reading of a call's conditions. Evaluating under `decide` pairs
 * the two halves of `fetch(isNew ? "/x" : `/x/${id}`, { method: isNew ? "POST" :
 * "PUT" })`, so POST /x/${id} is never invented: the same condition takes the same
 * branch everywhere in one reading.
 */
type Decide = (condition: string) => boolean;

function eachReading<T>(evaluate: (decide: Decide) => T): T[] {
  const results: T[] = [];
  const pending: Map<string, boolean>[] = [new Map()];
  while (pending.length > 0 && results.length < MAX_WORLDS) {
    const assumed = pending.pop() as Map<string, boolean>;
    results.push(
      evaluate((condition) => {
        const known = assumed.get(condition);
        if (known !== undefined) return known;
        pending.push(new Map(assumed).set(condition, false));
        assumed.set(condition, true);
        return true;
      }),
    );
  }
  return results;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `!x` and `x` are one condition with opposite answers. */
function conditionOf(node: ts.Expression): { key: string; negated: boolean } {
  let e = unwrap(node);
  let negated = false;
  while (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    negated = !negated;
    e = unwrap(e.operand);
  }
  return { key: collapse(e.getText()), negated };
}

type Lookup =
  | { kind: "value"; initializer: ts.Expression; assignments: ts.Expression[] }
  | { kind: "function"; returns: ts.Expression[] }
  | { kind: "unknown" };

function returnsOf(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

function assignmentsTo(name: string, scope: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === name
    ) {
      out.push(n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

function declarationIn(
  statements: ts.NodeArray<ts.Statement>,
  name: string,
  scope: ts.Node,
): Lookup | null {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return { kind: "function", returns: returnsOf(statement) };
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
      if (!d.initializer) return { kind: "unknown" };
      const value = unwrap(d.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        return { kind: "function", returns: returnsOf(value) };
      }
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      return {
        kind: "value",
        initializer: d.initializer,
        assignments: isConst ? [] : assignmentsTo(name, scope),
      };
    }
  }
  return null;
}

/** Walks out from `from` to the declaration `name` means there. */
function lookUp(name: string, from: ts.Node): Lookup {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const isParam = scope.parameters.some((p) => p.name.getText() === name);
      if (isParam) return { kind: "unknown" };
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope)) {
      const found = declarationIn(scope.statements, name, scope);
      if (found) return found;
    }
  }
  return { kind: "unknown" };
}

/** A string; `null` when it can't be known statically; `undefined` when there's no value. */
type Evaluated = string | null | undefined;

/** One of several possible values, chosen by `decide` so each gets its own reading. */
function oneOf(options: ts.Expression[], label: string, decide: Decide, depth: number): Evaluated {
  if (options.length === 0) return null;
  for (const [i, option] of options.slice(0, -1).entries()) {
    if (decide(`${label}#${i}`)) return evaluate(option, decide, depth + 1);
  }
  return evaluate(options.at(-1) as ts.Expression, decide, depth + 1);
}

function evaluateTemplate(e: ts.TemplateExpression, decide: Decide, depth: number): Evaluated {
  let text = e.head.text;
  for (const span of e.templateSpans) {
    text += (evaluate(span.expression, decide, depth + 1) ?? UNKNOWN) + span.literal.text;
  }
  return text;
}

function evaluateBinary(e: ts.BinaryExpression, decide: Decide, depth: number): Evaluated {
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.PlusToken) {
    const left = evaluate(e.left, decide, depth + 1) ?? UNKNOWN;
    return left + (evaluate(e.right, decide, depth + 1) ?? UNKNOWN);
  }
  if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
    const { key, negated } = conditionOf(e.left);
    return decide(key) !== negated
      ? evaluate(e.left, decide, depth + 1)
      : evaluate(e.right, decide, depth + 1);
  }
  return null;
}

function evaluate(node: ts.Expression, decide: Decide, depth = 0): Evaluated {
  if (depth > 12) return null;
  const e = unwrap(node);
  if (ts.isStringLiteralLike(e)) return e.text;
  if (e.kind === ts.SyntaxKind.NullKeyword) return undefined;
  if (ts.isTemplateExpression(e)) return evaluateTemplate(e, decide, depth);
  if (ts.isBinaryExpression(e)) return evaluateBinary(e, decide, depth);
  if (ts.isConditionalExpression(e)) {
    const { key, negated } = conditionOf(e.condition);
    const branch = decide(key) !== negated ? e.whenTrue : e.whenFalse;
    return evaluate(branch, decide, depth + 1);
  }
  if (ts.isIdentifier(e)) {
    if (e.text === "undefined") return undefined;
    const found = lookUp(e.text, e.parent);
    if (found.kind !== "value") return null;
    const options = [...found.assignments, found.initializer];
    return oneOf(options, `let ${e.text}`, decide, depth);
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const found = lookUp(e.expression.text, e.parent);
    if (found.kind !== "function") return null;
    return oneOf(found.returns, `${e.expression.text}()`, decide, depth);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client calls
// ---------------------------------------------------------------------------

/** What a recognised call hands over before its conditions are read. */
interface CallShape {
  url: ts.Expression | undefined;
  /** A fixed verb, or the expression that chooses one. */
  method: string | ts.Expression | null;
}

function property(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (p.name?.getText() !== name) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
  }
  return undefined;
}

function objectFrom(node: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!node) return null;
  const e = unwrap(node);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (ts.isIdentifier(e)) {
    const found = lookUp(e.text, e.parent);
    if (found.kind === "value" && found.assignments.length === 0) {
      return objectFrom(found.initializer);
    }
  }
  return null;
}

/** `fetch(url, init)`: GET unless init says otherwise, unknown if init can't be read. */
function fetchShape(call: ts.CallExpression): CallShape {
  const [url, init] = call.arguments;
  if (!init) return { url, method: "GET" };
  const options = objectFrom(init);
  if (!options) return { url, method: null };
  const method = property(options, "method");
  if (method) return { url, method };
  const spreads = options.properties.some((p) => ts.isSpreadAssignment(p));
  return { url, method: spreads ? null : "GET" };
}

/** `axios.request({ url, method })` and `axios({ url, method })`. */
function configShape(call: ts.CallExpression): CallShape {
  const options = objectFrom(call.arguments[0]);
  if (!options) return { url: call.arguments[0], method: null };
  return { url: property(options, "url"), method: property(options, "method") ?? "GET" };
}

function axiosMemberShape(call: ts.CallExpression, callee: ts.Expression): CallShape | null {
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    if (AXIOS_VERBS.has(name)) return { url: call.arguments[0], method: name.toUpperCase() };
    if (name === "request") return configShape(call);
    return null;
  }
  // axios[verb](url)
  if (ts.isElementAccessExpression(callee)) {
    return { url: call.arguments[0], method: callee.argumentExpression };
  }
  return null;
}

function isNamed(e: ts.Expression, name: string): boolean {
  return ts.isIdentifier(e) && e.text === name;
}

function isFetch(callee: ts.Expression): boolean {
  if (isNamed(callee, "fetch")) return true;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "fetch" &&
    (isNamed(callee.expression, "window") || isNamed(callee.expression, "globalThis"))
  );
}

/** The shape of a call that sends a request, or null when this call doesn't. */
function shapeOf(call: ts.CallExpression): CallShape | null {
  const callee = call.expression;
  if (isFetch(callee)) return fetchShape(call);
  if (isNamed(callee, "axios")) return configShape(call);
  // This hook GETs the URL it's handed, so its callers are the real call sites.
  if (isNamed(callee, "useFetchOptions")) return { url: call.arguments[0], method: "GET" };
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    isNamed(callee.expression, "axios")
  ) {
    return axiosMemberShape(call, callee);
  }
  return null;
}

/**
 * True for a reference to axios or fetch that could send a request by a route this
 * reader can't follow: `const send = isEdit ? axios.put : axios.post`, or `.then(fetch)`.
 */
function isEscapingReference(n: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(n) && isNamed(n.expression, "axios")) {
    if (AXIOS_HELPERS.has(n.name.text)) return false;
    return !(ts.isCallExpression(n.parent) && n.parent.expression === n);
  }
  if (ts.isElementAccessExpression(n) && isNamed(n.expression, "axios")) {
    return !(ts.isCallExpression(n.parent) && n.parent.expression === n);
  }
  if (ts.isIdentifier(n) && (n.text === "fetch" || n.text === "axios")) {
    const p = n.parent;
    // Argument or value positions only: not `axios.x`, not `{ fetch: ... }`, not the import.
    return (
      (ts.isCallExpression(p) && p.expression !== n) ||
      ts.isConditionalExpression(p) ||
      (ts.isVariableDeclaration(p) && p.initializer === n)
    );
  }
  return false;
}

export function parseClientCalls(file: string, source: string): ClientCall[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const calls: ClientCall[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const record = (call: ts.CallExpression, shape: CallShape) => {
    const expression = collapse((shape.url ?? call).getText());
    const readings = eachReading((decide) => {
      const url = shape.url ? evaluate(shape.url, decide) : null;
      let method: Evaluated = null;
      if (typeof shape.method === "string") method = shape.method;
      else if (shape.method) method = evaluate(shape.method, decide);
      return { url, method };
    });
    const seen = new Set<string>();
    for (const { url, method } of readings) {
      if (url === undefined) continue; // `cond ? url : null`: no request in this reading
      const verb = method?.toUpperCase() ?? null;
      const key = `${verb} ${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ file, line: lineOf(call), expression, method: verb, url });
    }
  };

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const shape = shapeOf(n);
      if (shape) record(n, shape);
    }
    if (isEscapingReference(n)) {
      calls.push({
        file,
        line: lineOf(n),
        expression: collapse(n.getText()),
        method: null,
        url: null,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls;
}

/** Every string in the file that names a path under /api, however it gets used. */
export function parseApiStrings(file: string, source: string): { line: number; url: string }[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: { line: number; url: string }[] = [];
  const visit = (n: ts.Node) => {
    const head = ts.isStringLiteralLike(n)
      ? n.text
      : ts.isTemplateExpression(n)
        ? n.head.text
        : null;
    if (head?.startsWith("/api/")) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const urls = eachReading((decide) => evaluate(n as ts.Expression, decide));
      for (const url of new Set(urls)) {
        if (typeof url === "string") found.push({ line, url });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// ---------------------------------------------------------------------------
// Judging a call against the routes
// ---------------------------------------------------------------------------

function pathOf(url: string): string {
  return url.split("?")[0].split("#")[0];
}

export function displayUrl(url: string): string {
  return url.replaceAll(UNKNOWN, "${…}");
}

type Match = { route: ApiRoute } | { choosesAmong: string[] } | null;

/** Next's order: a static segment, then `[x]`, then a catch-all. */
function match(segments: string[], routes: ApiRoute[], i = 0): Match {
  if (i === segments.length) {
    const exact = routes.find((r) => r.segments.length === i);
    if (exact) return { route: exact };
    const optional = routes.find(
      (r) => r.segments.length === i + 1 && r.segments[i].startsWith("[[..."),
    );
    return optional ? { route: optional } : null;
  }
  const segment = segments[i];
  const unknown = segment === UNKNOWN;
  const candidates: ApiRoute[][] = [
    unknown ? [] : routes.filter((r) => r.segments[i] === segment),
    routes.filter((r) => /^\[[^.[]/.test(r.segments[i] ?? "")),
  ];
  for (const nodes of candidates) {
    if (nodes.length === 0) continue;
    const found = match(segments, nodes, i + 1);
    if (found) return found;
  }
  const catchAll = routes.find((r) => /^\[\[?\.\.\./.test(r.segments[i] ?? ""));
  if (catchAll) return { route: catchAll };
  if (unknown) {
    // Only routes that can finish the path count. `/items/${id}/${action}` picks among
    // nothing when the actions live at `/items/mark-sold`.
    const statics = routes.flatMap((r) => r.segments[i] ?? []);
    const reachable = statics.filter((name) =>
      match(
        segments,
        routes.filter((r) => r.segments[i] === name),
        i + 1,
      ),
    );
    if (reachable.length > 0) return { choosesAmong: [...new Set(reachable)].sort() };
  }
  return null;
}

type Found =
  | { status: "found"; path: string; route: ApiRoute }
  | Extract<Verdict, { status: "not-api" | "no-route" | "unresolved" }>;

/** The route a URL reaches, whatever the method. */
export function findRoute(url: string, routes: ApiRoute[]): Found {
  if (url.startsWith(UNKNOWN)) {
    return { status: "unresolved", why: "the URL starts with a value known only at runtime" };
  }
  if (!url.startsWith("/api/")) return { status: "not-api" };

  const path = pathOf(url);
  const shown = displayUrl(path);
  const segments = path.split("/").filter(Boolean).slice(1);
  if (segments.some((s) => s !== UNKNOWN && s.includes(UNKNOWN))) {
    return { status: "unresolved", why: `a runtime value is glued to a segment: ${shown}` };
  }
  const found = match(segments, routes);
  if (!found) return { status: "no-route", path: shown };
  if ("choosesAmong" in found) {
    const among = found.choosesAmong.join(", ");
    return { status: "unresolved", why: `a runtime value picks among routes: ${among}` };
  }
  return { status: "found", path: shown, route: found.route };
}

export function judge(call: ClientCall, routes: ApiRoute[]): Verdict {
  if (call.url === null) return { status: "unresolved", why: "the URL can't be read statically" };
  const found = findRoute(call.url, routes);
  if (found.status !== "found") return found;
  if (call.method === null) {
    return { status: "unresolved", why: "the method can't be read statically" };
  }
  const { path, route } = found;
  if (route.methods === "any" || route.methods.has(call.method)) return { status: "ok", route };
  return { status: "no-method", path, route };
}

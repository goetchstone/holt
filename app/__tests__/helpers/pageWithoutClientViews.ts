// /app/__tests__/helpers/pageWithoutClientViews.ts
//
// A server page, imported with the client components it imports stood in by
// stubs, for tests of what the page itself decides: its requirePage gate, its
// redirect, and the props it hands its view.
//
// Jest instruments every file a test loads, and the merged coverage gate
// (scripts/test-coverage.sh) counts all of it. A static import of a page loads
// its "use client" view too, and everything the view imports. None of it
// renders in Node, so nearly all of it counts as uncovered, and a test written
// to hold a page's gate pulls the coverage floors down instead.
//
// So each import in the page's own source that names a local module ("./X" or
// "@/...") whose directive prologue holds "use client" gets a jest.doMock
// factory before the page is imported: Jest hands the page the stub module and
// never compiles, instruments or runs the real one. The stub module has a
// component that renders nothing for each runtime export, default included.
// That is all a server page can do with a client module in Next anyway: each
// export reaches it as a reference to render, never a value to call. The
// element a page returns has the stub as its type and the props the page
// computed, so a test asserts on `element.props` as before; for the stub itself,
// `jest.requireMock(<the client module>)` returns the module the page got.
//
// Only the page's own imports are stubbed. A client component reached through a
// server module the page imports still loads.

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import type { ReactElement } from "react";
import ts from "typescript";

/** A page's default export, as a test calls it: with its route params, or none. */
export type ServerPage = (props?: {
  params?: Promise<Record<string, string>>;
}) => Promise<ReactElement<Record<string, unknown>>>;

/**
 * Import the page at `page` (an `@/` specifier or an absolute path) with each
 * client module it imports replaced by stubs, and return its default export.
 */
export async function pageWithoutClientViews(page: string): Promise<ServerPage> {
  const file = require.resolve(page);
  for (const imported of localImports(file)) {
    if (!isClientModule(imported)) continue;
    const names = runtimeExports(imported);
    jest.doMock(imported, () => stubModule(names));
  }
  const loaded: { default: ServerPage } = await import(file);
  return loaded.default;
}

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);

/** The local modules ("./X" or "@/...") a file imports, resolved as Jest resolves them. */
function localImports(file: string): string[] {
  return parse(file)
    .statements.filter(ts.isImportDeclaration)
    .map((declaration) => (declaration.moduleSpecifier as ts.StringLiteral).text)
    .filter((specifier) => specifier.startsWith(".") || specifier.startsWith("@/"))
    .map((specifier) =>
      require.resolve(specifier.startsWith(".") ? resolve(dirname(file), specifier) : specifier),
    );
}

/** True when the module's directive prologue holds "use client", which is where Next reads it. */
function isClientModule(file: string): boolean {
  for (const statement of parse(file).statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

/** The names a module exports at runtime, "default" included. A type exports nothing. */
function runtimeExports(file: string): string[] {
  return [...new Set(parse(file).statements.flatMap((statement) => exported(statement, file)))];
}

/** What one top-level statement exports at runtime. */
function exported(statement: ts.Statement, file: string): string[] {
  if (ts.isExportAssignment(statement)) return ["default"];
  if (ts.isExportDeclaration(statement)) return reexported(statement, file);
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [];
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
    return ["default"];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => bound(declaration.name));
  }
  const { name } = statement as ts.DeclarationStatement;
  return name ? [name.text] : [];
}

function reexported(statement: ts.ExportDeclaration, file: string): string[] {
  const clause = statement.exportClause;
  if (statement.isTypeOnly) return [];
  if (!clause) {
    // The names behind `export *` are another module's, so no stub could stand
    // in for them by name. Refuse rather than hand the page `undefined`.
    throw new Error(`${file}: "export *" from a client module; export each name instead`);
  }
  if (ts.isNamespaceExport(clause)) return [clause.name.text];
  return clause.elements.filter((element) => !element.isTypeOnly).map((e) => e.name.text);
}

/** The names a declaration binds, through any destructuring. */
function bound(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bound(element.name),
  );
}

/** What Jest hands an importer of the client module: one empty component per name. */
function stubModule(names: string[]) {
  const stub = (name: string) => Object.defineProperty(() => null, "name", { value: name });
  return { __esModule: true, ...Object.fromEntries(names.map((name) => [name, stub(name)])) };
}

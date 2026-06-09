// /app/__tests__/brandTokens.test.ts
//
// Regression guard for the 2026-06-04 white-on-white bug: Tailwind 4 `@theme`
// color tokens must NOT carry the Tailwind 3 `<alpha-value>` placeholder.
// Tailwind 4 leaves it un-substituted, producing an invalid color value that
// the browser silently drops -- which made every sh-* brand color (and the whole
// navy sidebar) render transparent. Tailwind 4 applies opacity via color-mix, so
// the tokens must be plain `rgb(var(--brand-*))`.

import { readFileSync } from "node:fs";
import path from "node:path";

describe("brand color tokens (globals.css)", () => {
  const css = readFileSync(path.join(__dirname, "../src/styles/globals.css"), "utf8");

  it("has no <alpha-value> in any --color-* token definition", () => {
    const colorTokenLines = css.split("\n").filter((line) => /^\s*--color-[a-z-]+\s*:/.test(line));
    const offenders = colorTokenLines.filter((line) => line.includes("<alpha-value>"));
    expect(offenders).toEqual([]);
  });

  it("still defines the core sh-* tokens", () => {
    for (const token of ["--color-sh-navy", "--color-sh-blue", "--color-sh-gold"]) {
      expect(css).toContain(token);
    }
  });
});

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

  it("still defines the core brand-* tokens", () => {
    for (const token of ["--color-brand-navy", "--color-brand-blue", "--color-brand-gold"]) {
      expect(css).toContain(token);
    }
  });

  it("carries no client's initials in a token name", () => {
    // These were `sh-*` -- the initials of one deployment, baked into the
    // design system and therefore into every class name in the rendered DOM.
    // holt is white-label: the palette re-skins per deployment at runtime from
    // AppSettings.theme, so naming the tokens after one client was wrong even
    // before it became something a prospect could read in devtools.
    expect(css).not.toMatch(/--color-sh-/);
  });
});

describe("no client initials leak into the rendered DOM", () => {
  it("no source file uses an sh-* class", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process");
    const out = execSync(
      `grep -rhoE '\\bsh-[a-z0-9-]+' ${path.join(__dirname, "../src")} || true`,
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe("");
  });
});

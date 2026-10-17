// /app/__tests__/brandTokens.test.ts
//
// Regression guard for the 2026-06-04 white-on-white bug: Tailwind 4 `@theme`
// color tokens must NOT carry the Tailwind 3 `<alpha-value>` placeholder.
// Tailwind 4 leaves it un-substituted, producing an invalid color value that
// the browser silently drops -- which made every brand color (and the whole
// sidebar) render transparent. Tailwind 4 applies opacity via color-mix, so
// the tokens must be plain `rgb(var(--brand-*))`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Every .ts/.tsx file under src/. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("brand color tokens (globals.css)", () => {
  const css = readFileSync(path.join(__dirname, "../src/styles/globals.css"), "utf8");

  it("has no <alpha-value> in any --color-* token definition", () => {
    const colorTokenLines = css.split("\n").filter((line) => /^\s*--color-[a-z-]+\s*:/.test(line));
    const offenders = colorTokenLines.filter((line) => line.includes("<alpha-value>"));
    expect(offenders).toEqual([]);
  });

  it("gives every --color-* token a whole colour, never bare channels", () => {
    // "255 255 255" is only a colour inside rgb(). Six shadcn tokens were bare
    // channels: bg-card was transparent and a destructive button had no fill.
    const values = [...css.matchAll(/^\s*--color-[a-z0-9-]+\s*:\s*([^;]+);/gm)].map((m) =>
      m[1].trim(),
    );
    expect(values.length).toBeGreaterThan(0);
    const offenders = values.filter(
      (v) => !/^(rgb\(|#[0-9a-fA-F]{3,8}$|var\(|color-mix\()/.test(v),
    );
    expect(offenders).toEqual([]);
  });

  it("still defines the core brand-* tokens", () => {
    for (const token of ["--color-brand-navy", "--color-brand-blue", "--color-brand-gold"]) {
      expect(css).toContain(token);
    }
  });

  it("names color tokens only from the generic palette families", () => {
    // These tokens were once named after one deployment, which baked a
    // client's name into the design system and therefore into every class
    // name in the rendered DOM.
    // holt is white-label: the palette re-skins per deployment at runtime from
    // AppSettings.theme, so naming the tokens after one client was wrong even
    // before it became something a prospect could read in devtools. An
    // allowlist, so a new client-specific token prefix fails here rather than
    // shipping.
    const GENERIC_FAMILIES = new Set([
      "accent",
      "alert",
      "background",
      "bone",
      "border",
      "brand",
      "card",
      "conviction",
      "destructive",
      "foreground",
      "input",
      "midnight",
      "muted",
      "popover",
      "primary",
      "ring",
      "secondary",
      "site",
      "slate",
    ]);
    const families = [...css.matchAll(/^\s*--color-([a-z0-9]+)/gm)].map((m) => m[1]);
    expect(families.length).toBeGreaterThan(0);
    expect(families.filter((f) => !GENERIC_FAMILIES.has(f))).toEqual([]);
  });

  it("uses no Tailwind 3 opacity utilities, which Tailwind 4 dropped", () => {
    // `bg-black bg-opacity-50` is a Tailwind 3 pair. Tailwind 4 has no
    // `bg-opacity-*`, so only `bg-black` applied and three modal backdrops
    // rendered solid black. The Tailwind 4 spelling is `bg-black/50`.
    const offenders = sourceFiles(path.join(__dirname, "../src")).filter((file) =>
      /\b(bg|text|border|ring|divide|placeholder)-opacity-\d/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

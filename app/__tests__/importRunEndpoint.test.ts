// /app/__tests__/importRunEndpoint.test.ts
//
// Source-text guards on the commit path. The row-level behaviour lives in the
// registered runners and is tested there; what matters HERE is the set of
// properties that separate RUNNING an import from PREVIEWING one, each of
// which is a plausible, quiet regression:
//
//   - Running an INACTIVE definition would make isActive decorative. Preview
//     allows it on purpose; run must not.
//   - Falling back to runImportEngine when no runner is registered would report
//     "imported: N" for rows nothing wrote — worse than an error, because it
//     looks like success.
//   - Truncating rows would silently drop data and report success for the rest.
//     The preview may sample; this one moves data.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "src", "pages", "api", "admin", "imports");
const RUN = readFileSync(join(DIR, "run.ts"), "utf8");
const PREVIEW = readFileSync(join(DIR, "preview.ts"), "utf8");

describe("import run endpoint", () => {
  it("refuses an inactive definition", () => {
    expect(RUN).toMatch(/if\s*\(\s*!\s*definition\.isActive\s*\)/);
  });

  it("refuses a definition with no runnerKey instead of falling back to the planner", () => {
    expect(RUN).toMatch(/if\s*\(\s*!\s*definition\.runnerKey\s*\)/);
    // The engine writes nothing. Importing through it would report success for
    // rows that were never persisted.
    //
    // Asserted on the CALL, not the name: the handler's comment explains why it
    // does not use runImportEngine, and a bare substring check fails on its own
    // documentation. That exact crudeness muted two earlier tripwires in this
    // codebase, one of which matched its own helper's name in a header comment.
    expect(RUN).not.toMatch(/\brunImportEngine\s*\(/);
    expect(RUN).not.toMatch(/import\s*\{[^}]*runImportEngine[^}]*\}/);
  });

  it("refuses an oversized file rather than truncating it", () => {
    expect(RUN).toMatch(/rows\.length > MAX_ROWS/);
    expect(RUN).toContain("413");
    expect(RUN).not.toMatch(/rows\.slice\(0,\s*MAX_ROWS\)/);
  });

  it("dispatches through the registry, not a local switch", () => {
    // A second dispatch table is how the registry stops being the one place
    // runners are declared (rule 37).
    expect(RUN).toContain("getImportRunner(definition.runnerKey)");
  });

  it("records who ran it", () => {
    expect(RUN).toMatch(/logger\.info\(\s*"import definition run"/);
    expect(RUN).toMatch(/by:\s*session\.user\?\.email/);
  });

  it("takes the data-import gate, not the config-authoring one", () => {
    // Running an import moves data; authoring a definition does not. preview.ts
    // takes admin.config for the opposite reason.
    // Running an import writes historical records in bulk. Under the operating-role
    // model that is administration, not store management: MANAGER lost it
    // deliberately on 2026-08-21. Domain imports a Buyer or the data-entry team
    // load -- price lists, vendor invoices -- keep their DOMAIN permission.
    expect(RUN).toMatch(/requirePermission\(\s*\n?\s*"admin\.data"/);
    expect(PREVIEW).toMatch(/requirePermission\(\s*\n?\s*"admin\.config"/);
  });

  it("and the preview still writes nothing, so the pair stays a pair", () => {
    expect(PREVIEW.match(/prisma\.\w+\.(create|update|delete|upsert)\w*\s*\(/g) ?? []).toEqual([]);
  });
});

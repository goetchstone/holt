// /app/__tests__/importPreviewEndpoint.test.ts
//
// Source-text guards on the dry-run preview endpoint. The behaviour that
// matters is in lib/imports/engine.ts (already unit-tested); what matters HERE
// is the properties an endpoint can quietly lose in a later edit.
//
// Why these three: a preview that writes is not a preview, a preview that
// silently truncates reports a sample's summary as the file's, and a preview
// that refuses inactive definitions withholds the tool exactly when it is most
// needed — a definition ships inactive precisely while its mappings are still
// being worked out (config/presets/ordorite-payment-modes.yaml is the
// motivating case).

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "src", "pages", "api", "admin", "imports", "preview.ts"),
  "utf8",
);

describe("import preview endpoint", () => {
  it("never writes — no create/update/delete/upsert anywhere in it", () => {
    const writes = SRC.match(/prisma\.\w+\.(create|update|delete|upsert)\w*\s*\(/g) ?? [];
    expect(writes).toEqual([]);
  });

  it("reads the definition and nothing else from the database", () => {
    // findUnique on importDefinition is the only query it should make. A
    // preview that starts querying target tables is doing the commit path's
    // job with the preview path's permissions.
    const reads = SRC.match(/prisma\.(\w+)\./g) ?? [];
    expect([...new Set(reads)]).toEqual(["prisma.importDefinition."]);
  });

  it("gates on admin.config, matching the other config endpoints", () => {
    expect(SRC).toMatch(/requirePermission\(\s*\n?\s*"admin\.config"/);
  });

  it("reports truncation rather than silently sampling", () => {
    expect(SRC).toContain("truncated:");
    expect(SRC).toMatch(/rows\.length > MAX_PREVIEW_ROWS/);
  });

  it("previews an inactive definition instead of refusing it", () => {
    // A guard clause on isActive would be the easy, wrong edit.
    expect(SRC).not.toMatch(/if\s*\(\s*!\s*definition\.isActive\s*\)/);
  });
});

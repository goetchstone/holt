// /app/__tests__/securitySweep2026_06_10.test.ts
//
// Tripwires for the 2026-06-10 security-sweep fixes. Source-text checks per
// the repo's rule-12 convention — the bug class guarded is "a refactor
// reintroduces the session-only gate or the raw req.body spread."

import fs from "fs";
import path from "path";

function src(rel: string): string {
  return fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");
}

describe("security sweep 2026-06-10 tripwires", () => {
  it("vendors/[id] stays role-gated (was session-only)", () => {
    const code = src("pages/api/vendors/[id].ts");
    expect(code).toMatch(/requireAuthWithRole\(\s*\["MANAGER",\s*"ADMIN"\]/);
    expect(code).not.toMatch(/getServerSession/);
  });

  it("vendors/[id] never spreads req.body into the update (field whitelist)", () => {
    const code = src("pages/api/vendors/[id].ts");
    expect(code).not.toMatch(/data:\s*req\.body/);
    expect(code).toMatch(/Prisma\.VendorUpdateInput/);
  });

  it("invoice print view rounds the derived unit price", () => {
    const code = src("app/print/invoice/[id]/InvoicePrintView.tsx");
    expect(code).toMatch(/Math\.round\(\(li\.netPrice \/ li\.orderedQuantity\) \* 100\) \/ 100/);
  });
});

// /app/__tests__/uiRoleNameBranches.test.ts
//
// The UI does not decide what someone sees or may do from a role NAME. The
// owner configures access as keys in Admin > Roles (owner direction,
// 2026-09-24), and a custom role carries the enum DESIGNER, so a check like
// `if (role === "DESIGNER") redirect(...)` silently applies to every custom
// role. That one lived in app/(dashboard)/app/page.tsx until F1. Decide on the
// server with resolvePermissionAccess / requirePage({ permission }) and pass
// the answer down, as app/(dashboard)/app/page.tsx does for the home page.
//
// Every file under src/app and src/components is scanned, comments removed by
// the TypeScript printer (so prose and "//" inside strings do not count). The
// files that still branch on a role name are DECLARED DEBT below, each with
// its reason: a new one fails, and an entry whose file no longer branches must
// be deleted. (Page gates written as requirePage([...roles]) are tracked in
// pagePermissions.ts; API routes in sessionRoleReads.test.ts.)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(__dirname, "..", "src");
const ROOTS = [join(SRC, "app"), join(SRC, "components")];

const ROLE = String.raw`[\w$.?]*[Rr]ole\b`;
const NAME = String.raw`(?:["'\`][A-Z][A-Z_]+["'\`]|StaffRole\.\w+)`;
const ROLE_NAME_BRANCH = new RegExp(
  [
    String.raw`${ROLE}(?:\s+as\s+\w+)?\s*\)?\s*[!=]==?\s*${NAME}`, // role === "X", (role as string) === "X"
    String.raw`${NAME}\s*[!=]==?\s*\(?\s*${ROLE}`, // "X" === role
    String.raw`switch\s*\(\s*${ROLE}\s*\)`, // switch (role)
    String.raw`\[\s*${NAME}[^\]]*\]\s*\.includes\(\s*${ROLE}`, // ["X", "Y"].includes(role)
    String.raw`\b\w*(?:ROLES|Roles)\s*\.(?:has|includes)\(\s*${ROLE}`, // PRIVILEGED_ROLES.has(role)
  ].join("|"),
);

/** Declared debt: role-name decisions still in the UI, and why each is here. */
const ROLE_NAME_DEBT: Record<string, string> = {
  // By design: these mirror a rule the server enforces by role, by owner decision.
  "components/navigation/TopNav.tsx":
    "the 'View as' menu is offered to a real SUPER_ADMIN/ADMIN, the same rule as resolveEffectiveRole (roleDecision.ts)",
  "app/(dashboard)/app/admin/staff/StaffView.tsx":
    "the role picker mirrors lib/auth/roleAssignment.ts: only admins assign roles, only the owner the owner tier (USE-02)",
  // Debt: access decided by name while the route uses a key (PERM-01 / F6 / SEC-14).
  "components/layout/CardGrid.tsx":
    "hub cards filter by role arrays and SUPER_ADMIN sees all; cards should carry their destination's key (PERM-01)",
  "components/layout/CardGridPageLayout.tsx":
    "same SUPER_ADMIN shortcut as CardGrid for the hub layout (PERM-01)",
  "app/(dashboard)/app/sales/orders/[id]/OrderDetailView.tsx":
    "change-salesperson and void-payment buttons by MANAGER/ADMIN name; the routes use sales.reassign / payment.void",
  "app/(dashboard)/app/sales/till/[id]/TillDetailView.tsx":
    "the Reconcile button by MANAGER/ADMIN name, mirroring reconcile.ts's role list (F6)",
  "app/(dashboard)/app/leads/LeadsView.tsx":
    "manager-only lead actions by role name rather than the lead keys",
  "app/(dashboard)/app/sales/pipeline/PipelineView.tsx":
    "wealth data shown to ADMIN/MARKETING by name (the Wealth Data Visibility precedent); should be a key (SEC-14)",
  "app/(dashboard)/app/sales/customers/CustomersListView.tsx":
    "wealth columns and manager actions by role name; should be keys (SEC-14)",
  "app/(dashboard)/app/sales/customers/[id]/CustomerDetailView.tsx":
    "wealth data and manager actions by role name; should be keys (SEC-14)",
  "app/(dashboard)/app/reports/sales-by-salesperson/SalesBySalespersonView.tsx":
    "the salesperson picker for PRIVILEGED_ROLES by name (who sees others' sales: F3); cost and margin already follow View cost on the server",
  "app/(dashboard)/app/reports/designer-dashboard/DesignerDashboardView.tsx":
    "the 'see every designer' view and the salesperson list by role name; should be a reporting key and isDesigner",
  "app/(dashboard)/app/reports/monthly-performance/MonthlyPerformanceView.tsx":
    "the salesperson list by role name; should filter on the admin-set isDesigner flag",
  "app/(dashboard)/app/reports/salesperson-detail/SalespersonDetailView.tsx":
    "the salesperson list and manager view by role name; should be isDesigner and a reporting key",
  // Debt: data filters on the role enum (custom roles show up as designers).
  "app/(dashboard)/app/admin/sales/goals/SalesGoalsView.tsx":
    "picks salespeople by DESIGNER/MANAGER enum; should filter on the admin-set isDesigner flag",
  "app/(dashboard)/app/service/house-calls/HouseCallsView.tsx":
    "picks designers for house calls by role enum; should filter on isDesigner",
  "app/(dashboard)/app/service/house-calls/new/NewHouseCallView.tsx":
    "picks designers for a new house call by role enum; should filter on isDesigner",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Source with comments removed by the TypeScript printer (string-aware). */
function code(path: string): string {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    kind,
  );
  return ts.createPrinter({ removeComments: true }).printFile(sf);
}

const scanned = ROOTS.flatMap(files);
const branching = new Set(
  scanned.filter((f) => ROLE_NAME_BRANCH.test(code(f))).map((f) => relative(SRC, f)),
);

describe("the UI never decides access from a role name", () => {
  it("scans the files it was written for", () => {
    expect(scanned.length).toBeGreaterThan(400);
  });

  it("catches the shapes it is meant to catch", () => {
    for (const shape of [
      'if (role === "DESIGNER") redirect("/app/sales");',
      'if ("ADMIN" === session.user.role) {}',
      'if ((role as string) === "MANAGER") {}',
      'switch (effectiveRole) { case "HR": }',
      '["MANAGER", "ADMIN"].includes(userRole)',
      "PRIVILEGED_ROLES.has(role)",
      "role === StaffRole.ADMIN",
    ]) {
      expect({ shape, caught: ROLE_NAME_BRANCH.test(shape) }).toEqual({ shape, caught: true });
    }
    for (const fine of ['const accept = "image/*";', 'permission: "sales.read"', "roleId === 4"]) {
      expect({ fine, caught: ROLE_NAME_BRANCH.test(fine) }).toEqual({ fine, caught: false });
    }
  });

  it("no file outside the declared debt branches on a role name", () => {
    expect([...branching].filter((f) => !(f in ROLE_NAME_DEBT)).sort()).toEqual([]);
  });

  it("every debt entry still branches (delete it when you fix it) and says why", () => {
    for (const [file, reason] of Object.entries(ROLE_NAME_DEBT)) {
      expect({ file, stillBranches: branching.has(file) }).toEqual({ file, stillBranches: true });
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it("the home page is not on the debt list: F1 removed its role redirect", () => {
    expect(branching.has("app/(dashboard)/app/page.tsx")).toBe(false);
    expect("app/(dashboard)/app/page.tsx" in ROLE_NAME_DEBT).toBe(false);
  });
});

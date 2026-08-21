import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * Which departments a deployment reports on, and how they roll up.
 *
 * crossSell.ts and designerDashboard.ts each used to carry a hardcoded list of
 * department NAMES -- "Rugs", "Curtains", "Womens Apparel". That is one
 * retailer's merchandise taxonomy compiled into shared report code: for any
 * other deployment the dashboard bucketed everything into a single fallback
 * column and the cross-sell report offered nothing, with no error to notice
 * (CLAUDE.md rule 61 -- deployment facts are config, not literals).
 *
 * The facts now live on Department, where an operator can change them:
 * `reportGroup`, `crossSellTarget`, `crossSellAnchor`. Migration
 * 20260821120000_department_report_roles backfilled all three from the
 * literals, so existing deployments report identical numbers.
 *
 * ONE DELIBERATE BEHAVIOUR CHANGE. The old classifier ended in a fallthrough:
 * a department matching no keyword landed in "Home Shop". A department created
 * after this migration has `reportGroup = NULL` and is EXCLUDED instead, so new
 * merchandise cannot quietly inflate a bucket nobody chose for it. Excluding
 * sales silently is its own bug, though, so the excluded names are returned
 * here for the caller to surface rather than just dropped.
 */
export interface ReportTaxonomy {
  /** Lowercased department name -> the group it rolls up into. */
  groupByDepartment: Map<string, string>;
  /** Distinct groups, in a stable order, for rendering as columns. */
  groups: string[];
  /** Departments with no group: excluded from the dashboard, and reportable. */
  excludedDepartments: string[];
  /** Department names offered as cross-sell opportunities. */
  crossSellTargets: string[];
  /** The department whose spend qualifies a customer for the cross-sell report. */
  crossSellAnchor: string | null;
}

type DepartmentClient = Pick<PrismaClient["department"], "findMany">;

export async function loadReportTaxonomy(
  prisma: { department: DepartmentClient } | Prisma.TransactionClient,
): Promise<ReportTaxonomy> {
  const departments = await prisma.department.findMany({
    select: {
      name: true,
      reportGroup: true,
      crossSellTarget: true,
      crossSellAnchor: true,
    },
    orderBy: { name: "asc" },
  });

  const groupByDepartment = new Map<string, string>();
  const excludedDepartments: string[] = [];
  const groups: string[] = [];
  const crossSellTargets: string[] = [];
  let crossSellAnchor: string | null = null;

  for (const d of departments) {
    if (d.reportGroup) {
      groupByDepartment.set(d.name.toLowerCase(), d.reportGroup);
      if (!groups.includes(d.reportGroup)) groups.push(d.reportGroup);
    } else {
      excludedDepartments.push(d.name);
    }
    if (d.crossSellTarget) crossSellTargets.push(d.name);
    // First one wins. Two anchors is a misconfiguration, not a feature -- the
    // report qualifies on a single department's spend.
    if (d.crossSellAnchor && crossSellAnchor === null) crossSellAnchor = d.name;
  }

  groups.sort((a, b) => a.localeCompare(b));
  return {
    groupByDepartment,
    groups,
    excludedDepartments,
    crossSellTargets,
    crossSellAnchor,
  };
}

/**
 * The group a line item's department rolls up into, or null when it is
 * excluded.
 *
 * A line item with NO department is excluded too. The old code sent those to
 * "Home Shop", which meant an unclassified line silently became merchandise
 * revenue in a named bucket.
 */
export function groupForDepartment(
  deptName: string | null | undefined,
  taxonomy: ReportTaxonomy,
): string | null {
  if (!deptName) return null;
  return taxonomy.groupByDepartment.get(deptName.toLowerCase()) ?? null;
}

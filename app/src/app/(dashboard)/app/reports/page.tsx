// /app/src/app/(dashboard)/app/reports/page.tsx
//
// Reports hub — App Router port of the legacy reports/index. Any signed-in user
// (cards self-filter by role via CardGrid). The card list is the migration's
// index of every ported report; hrefs are unchanged so existing links keep
// working. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

// Monthly Performance + Salesperson Detail are intentionally not surfaced here
// (owner direction 2026-05-29 — superseded by the pay-period statement + Sales
// by Salesperson). Their routes still exist; they're just not in the hub.
const ITEMS: CardGridItem[] = [
  {
    title: "Designer Dashboard",
    description:
      "Individual salesperson performance: sales, quotes, and house calls with YoY comparison.",
    href: "/app/reports/designer-dashboard",
  },
  {
    title: "Pay Period Sales",
    description:
      "Bi-weekly pay-period statement per designer — order detail, period total, YTD. Confirm/lock + report-an-issue ledger. Split orders credited at 50%. CSV export.",
    href: "/app/reports/pay-period-sales",
    roles: ["SUPER_ADMIN"],
  },
  {
    title: "Team Commission",
    description:
      "Locked commission payouts by designer and pay period. View only — the commission plan and payout locking stay on the admin commission surface.",
    href: "/app/reports/commission",
    roles: ["SUPER_ADMIN"],
  },
  {
    title: "Comparative Sales",
    description:
      "Compare two date ranges by store with dollar and percentage variance. Filter by department.",
    href: "/app/reports/comparative-sales",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Sales Explorer",
    description:
      "Compare two periods across Store, Department, Category, and Vendor in one expandable pivot tree, with variance and margin at every level plus drill-down to product-level rows.",
    href: "/app/reports/sales-explorer",
    roles: ["SUPER_ADMIN", "ADMIN", "MANAGER"],
  },
  {
    title: "Gross Margin",
    description:
      "Revenue, cost, and margin for a date range. Pivot by department or vendor to see where the profit actually comes from. Flags rows where cost is missing.",
    href: "/app/reports/gross-margin",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Inventory Health",
    description:
      "On-hand valuation (at cost and retail) plus dead stock — inventory that hasn't sold in your chosen window. Pivot by department or vendor to find where cash is tied up and stuck.",
    href: "/app/reports/inventory-health",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "PO Sell-Thru",
    description:
      "Pick purchase orders by number and see how much of what they delivered has sold — sell-through, margin, and realized retail per frame, windowed from each line's receive date.",
    href: "/app/reports/po-sell-thru",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Top & Bottom Sellers",
    description:
      "Best and worst products by revenue, units, or margin for a date range. Filter by department to focus on merchandise; the margin view surfaces anything sold below cost.",
    href: "/app/reports/top-sellers",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Returns Analysis",
    description:
      "Return rate by department or vendor plus the most-returned products. Shows where merchandise is coming back so you can act on quality or fit issues.",
    href: "/app/reports/returns",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Open PO Gaps",
    description:
      "Purchase orders missing expected delivery dates or vendor acknowledgement numbers.",
    href: "/app/reports/po-gaps",
    roles: ["ADMIN"],
  },
  {
    title: "Weekly Summary",
    description: "Visual dashboard of sales vs. goals for the uploaded sales period.",
    href: "/app/reports/weekly-summary",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Detailed Sales Report",
    description: "In-depth, filterable table of all sales data.",
    href: "/app/reports/detailed-sales",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Sales by Salesperson",
    description:
      "Date-range sales totals with retail, cost, and margin. Group by salesperson, department, or customer. Multi-select dept filter. CSV export. Designers can run for their own data.",
    href: "/app/reports/sales-by-salesperson",
  },
  {
    title: "Mailchimp Campaign Impact",
    description:
      "Every campaign ranked by the revenue it generated -- purchases within 30 days of an open or click, broken down by department.",
    href: "/app/reports/mailchimp",
    roles: ["ADMIN", "MARKETING"],
  },
  {
    title: "Mailchimp Activity Log",
    description: "View detailed subscriber activities.",
    href: "/app/reports/mailchimp/activity",
    roles: ["ADMIN", "MARKETING"],
  },
  {
    title: "Customer Report",
    description: "Contact list with order history, spend, and credit balances.",
    href: "/app/reports/customers",
    roles: ["ADMIN", "MARKETING"],
  },
  {
    title: "Tax Summary",
    description: "Tax collected by period and store, sourced from invoices.",
    href: "/app/reports/tax-summary",
    roles: ["ADMIN"],
  },
  {
    title: "Till Reconciliation",
    description: "Review end-of-day drawer counts and variances.",
    href: "/app/reports/till-reconciliation",
    roles: ["ADMIN"],
  },
  {
    title: "Wealth Insights",
    description:
      "Customer wealth tiers, lifestyle signals, recent movers, and top customers by net worth.",
    href: "/app/reports/wealth-insights",
    roles: ["ADMIN", "MARKETING"],
  },
  {
    title: "Consignment Summary",
    description:
      "Inventory counts and vendor obligations across all consignment items by status and vendor.",
    href: "/app/reports/consignment-report",
    roles: ["ADMIN"],
  },
  {
    title: "Pipeline Opportunity",
    description: "Open quotes and orders by salesperson with conversion rates and pipeline value.",
    href: "/app/reports/pipeline-opportunity",
    roles: ["MANAGER", "ADMIN"],
  },
  {
    title: "Opportunities",
    description:
      "Customer lists worth emailing this week. Dormant VIPs, big wallets with small baskets, second-home owners, and more.",
    href: "/app/reports/opportunities",
    roles: ["MARKETING", "ADMIN"],
  },
  {
    title: "Buyers Report",
    description:
      "On hand, on order, and sold for a date range. Pivot by department or by vendor. Merchant decision-making in one screen.",
    href: "/app/reports/buyers",
    roles: ["ADMIN"],
  },
  {
    title: "Stale Quote Cleanup",
    description:
      "Old quotes needing follow-up or closure. Clean the pipeline and find forgotten opportunities.",
    href: "/app/reports/stale-quotes",
    roles: ["ADMIN"],
  },
  {
    title: "Balance Due Aging",
    description: "Unpaid balances on open orders by age bucket. Money that needs collection.",
    href: "/app/reports/balance-aging",
    roles: ["ADMIN"],
  },
  {
    title: "Service KPIs",
    description:
      "Customer-service queue health. Resolution time vs goal, age distribution, top open cases, and how many are blocked waiting on a vendor or customer.",
    href: "/app/reports/service",
    roles: ["MANAGER", "ADMIN", "SUPER_ADMIN"],
  },
  {
    title: "Store Traffic",
    description:
      "Per-store door-counter visitors from Axper. Daily trend by store, busiest-day + busiest-hour KPIs, day-of-week patterns, CSV export. Today is live; history reads from the persisted snapshot.",
    href: "/app/reports/traffic",
    roles: ["MANAGER", "ADMIN", "SUPER_ADMIN"],
  },
];

export default async function ReportsHubPage() {
  await requirePage();
  return <CardGrid title="Reports" items={ITEMS} />;
}

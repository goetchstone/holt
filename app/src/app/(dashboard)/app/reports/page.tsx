// /app/src/app/(dashboard)/app/reports/page.tsx
//
// Reports hub — App Router port of the legacy reports/index, on View reports. A
// card shows only to a reader holding the key of the report it opens (and, for
// the Mailchimp Activity Log, the key of its data: lib/auth/hubCards.ts), so the
// hub never lists a report its reader cannot open. The card list is the
// migration's index of every ported report; hrefs are unchanged so existing
// links keep working. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { hubCardKeys, visibleHubCards } from "@/lib/auth/hubCards";
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
      "Bi-weekly pay-period statement per designer — order detail, period total, YTD. Confirm/lock + report-an-issue ledger. Split orders credited at each designer's share. CSV export.",
    href: "/app/reports/pay-period-sales",
  },
  {
    title: "Commission",
    description:
      "Commission payouts by pay period: locked payouts with their paid dates, drafts to review and lock, and the tier calculator.",
    href: "/app/admin/reports/commission-tiers?tab=locked",
  },
  {
    title: "Comparative Sales",
    description:
      "Compare two date ranges by store with dollar and percentage variance. Filter by department.",
    href: "/app/reports/comparative-sales",
  },
  {
    title: "Sales Explorer",
    description:
      "Compare two periods across Store, Department, Category, and Vendor in one expandable pivot tree, with variance and margin at every level plus drill-down to product-level rows.",
    href: "/app/reports/sales-explorer",
  },
  {
    title: "Gross Margin",
    description:
      "Revenue, cost, and margin for a date range. Pivot by department or vendor to see where the profit actually comes from. Flags rows where cost is missing.",
    href: "/app/reports/gross-margin",
  },
  {
    title: "Inventory Health",
    description:
      "On-hand valuation (at cost and retail) plus dead stock — inventory that hasn't sold in your chosen window. Pivot by department or vendor to find where cash is tied up and stuck.",
    href: "/app/reports/inventory-health",
  },
  {
    title: "Follow-Ups",
    description:
      "Every client's next follow-up across the team: who's due, who it belongs to, and contacts logged by each salesperson.",
    href: "/app/reports/follow-ups",
  },
  {
    title: "Aged Stock",
    description:
      "How long uncommitted stock has been here, counted from when it came onto the books, with the oldest products listed.",
    href: "/app/reports/aged-stock",
  },
  {
    title: "Inventory Value",
    description:
      "What was on the books at the end of any past day, by department or vendor, for one store or all of them, in today's money.",
    href: "/app/reports/inventory-value",
  },
  {
    title: "PO Sell-Thru",
    description:
      "Pick purchase orders by number and see how much of what they delivered has sold — sell-through, margin, and realized retail per frame, windowed from each line's receive date.",
    href: "/app/reports/po-sell-thru",
  },
  {
    title: "Top & Bottom Sellers",
    description:
      "Best and worst products by revenue, units, or margin for a date range. Filter by department to focus on merchandise; the margin view surfaces anything sold below cost.",
    href: "/app/reports/top-sellers",
  },
  {
    title: "Returns Analysis",
    description:
      "Return rate by department or vendor plus the most-returned products. Shows where merchandise is coming back so you can act on quality or fit issues.",
    href: "/app/reports/returns",
  },
  {
    title: "Oversold",
    description:
      "Sales that went through with less free stock than they needed, by product — the orders waiting, and the quickest fix: stock free at another store, units already on a PO, or start a draft PO. Rows close themselves once covered.",
    href: "/app/reports/oversold",
  },
  {
    title: "On hold",
    description:
      "Floor stock quotes are holding for their customers, soonest to end first — who it is for, who quoted it, how many units are held and where they sit. A hold drops off the day after it ends, when the piece goes back on sale.",
    href: "/app/reports/on-hold",
  },
  {
    title: "Referrals",
    description:
      "How customers heard of you and who sent them: customers, how many bought, and what they spent, by source and by referring customer.",
    href: "/app/reports/referrals",
  },
  {
    title: "Stock and Space",
    description:
      "Everything in a store, a building or any place inside it, grouped by the places in it, place type, department, category, vendor or collection — with the units and each group's share of the measured floor.",
    href: "/app/reports/stock-by",
  },
  {
    title: "Transfers",
    description:
      "What moved between stores in a period, by route and one by one, and what is still on its way.",
    href: "/app/reports/transfers",
  },
  {
    title: "Unclassified Returns",
    description:
      "Returns booked on the default restock assumption because no Return record classifies them — the accountant's worklist to review and correct any that were actually written off.",
    href: "/app/reports/unclassified-returns",
  },
  {
    title: "Unmapped Payments",
    description:
      "Tender types with no GL mapping, so the sales journal drops them with only a warning — how much money is off the books, and the exact mapping rows to add.",
    href: "/app/reports/unmapped-payments",
  },
  {
    title: "Open PO Gaps",
    description:
      "Purchase orders missing expected delivery dates or vendor acknowledgement numbers.",
    href: "/app/reports/po-gaps",
  },
  {
    title: "Weekly Summary",
    description: "Visual dashboard of sales vs. goals for the uploaded sales period.",
    href: "/app/reports/weekly-summary",
  },
  {
    title: "Detailed Sales Report",
    description: "In-depth, filterable table of all sales data.",
    href: "/app/reports/detailed-sales",
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
  },
  {
    title: "Mailchimp Activity Log",
    description: "View detailed subscriber activities.",
    href: "/app/reports/mailchimp/activity",
  },
  {
    title: "Customer Report",
    description: "Contact list with order history, spend, and credit balances.",
    href: "/app/reports/customers",
  },
  {
    title: "Tax Summary",
    description: "Tax collected by period and store, sourced from invoices.",
    href: "/app/reports/tax-summary",
  },
  {
    title: "Till Reconciliation",
    description: "Review end-of-day drawer counts and variances.",
    href: "/app/reports/till-reconciliation",
  },
  {
    title: "Wealth Insights",
    description:
      "Customer wealth tiers, lifestyle signals, recent movers, and top customers by net worth.",
    href: "/app/reports/wealth-insights",
  },
  {
    title: "Consignment Summary",
    description:
      "Inventory counts and vendor obligations across all consignment items by status and vendor.",
    href: "/app/reports/consignment-report",
  },
  {
    title: "Pipeline Opportunity",
    description: "Open quotes and orders by salesperson with conversion rates and pipeline value.",
    href: "/app/reports/pipeline-opportunity",
  },
  {
    title: "Opportunities",
    description:
      "Customer lists worth emailing this week. Dormant VIPs, big wallets with small baskets, second-home owners, and more.",
    href: "/app/reports/opportunities",
  },
  {
    title: "Buyers Report",
    description:
      "On hand, on order, and sold for a date range. Pivot by department or by vendor. Merchant decision-making in one screen.",
    href: "/app/reports/buyers",
  },
  {
    title: "Stale Quote Cleanup",
    description:
      "Old quotes needing follow-up or closure. Clean the pipeline and find forgotten opportunities.",
    href: "/app/reports/stale-quotes",
  },
  {
    title: "Balance Due Aging",
    description: "Unpaid balances on open orders by age bucket. Money that needs collection.",
    href: "/app/reports/balance-aging",
  },
  {
    title: "Service KPIs",
    description:
      "Customer-service queue health. Resolution time vs goal, age distribution, top open cases, and how many are blocked waiting on a vendor or customer.",
    href: "/app/reports/service",
  },
  {
    title: "Store Traffic",
    description:
      "Per-store door-counter visitors from Axper. Daily trend by store, busiest-day + busiest-hour KPIs, day-of-week patterns, CSV export. Today is live; history reads from the persisted snapshot.",
    href: "/app/reports/traffic",
  },
  {
    title: "Build Your Own",
    description:
      "List or total sales, purchasing, products, customers, consignment, service cases and transfers. Group, pivot and export.",
    href: "/app/tools/query-builder",
  },
];

export default async function ReportsHubPage() {
  const { holds } = await requirePage(undefined, {
    permission: "reporting.read",
    also: hubCardKeys(ITEMS),
  });
  return <CardGrid title="Reports" items={visibleHubCards(ITEMS, holds)} />;
}

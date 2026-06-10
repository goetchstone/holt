// /app/src/app/(dashboard)/app/sales/page.tsx
//
// Sales hub — App Router port of the legacy sales/index. Any signed-in user
// (cards self-filter by role via CardGrid). Hrefs are unchanged so existing
// links — including those to still-Pages detail routes — keep working. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Pipeline",
    description: "Your active quotes and leads — follow up, track urgency, and log contacts.",
    href: "/app/sales/pipeline",
    roles: ["ADMIN", "MANAGER", "DESIGNER"],
  },
  {
    title: "New Quote",
    description: "Build a quote with configured, catalog, or custom items.",
    href: "/app/sales/quotes/new",
    roles: ["ADMIN"],
  },
  {
    title: "Point of Sale",
    description: "Scan items, build a cart, and process sales.",
    href: "/app/sales/pos",
    roles: ["ADMIN", "REGISTER"],
    feature: "pos",
  },
  {
    title: "Invoices",
    description:
      "Bill a customer directly — draft, issue to the books, email with a Stripe pay link, and record payments.",
    href: "/app/sales/invoices",
    roles: ["MANAGER", "ADMIN"],
    feature: "billing",
  },
  {
    title: "Quotes",
    description: "View and manage open quotes.",
    href: "/app/sales/orders?status=QUOTE",
    roles: ["ADMIN", "MANAGER", "DESIGNER"],
  },
  {
    title: "Orders",
    description: "Manage confirmed customer orders.",
    href: "/app/sales/orders",
    roles: ["ADMIN", "MANAGER", "DESIGNER"],
  },
  {
    title: "Customers",
    description: "Search, view, and update customer profiles",
    href: "/app/sales/customers",
  },
  {
    title: "Gift Card Sale",
    description: "Sell and activate gift cards using quick codes.",
    href: "/app/sales/gift-card-sale",
    roles: ["ADMIN", "REGISTER"],
    feature: "giftCards",
  },
  {
    title: "Till",
    description: "Open, manage, and close your cash drawer.",
    href: "/app/sales/till",
    roles: ["ADMIN", "REGISTER"],
    feature: "tills",
  },
  {
    title: "Returns",
    description: "Initiate and track customer returns.",
    href: "/app/sales/returns",
    roles: ["ADMIN"],
  },
  {
    title: "House Calls",
    description: "Schedule and manage designer home visits.",
    href: "/app/service/house-calls",
    roles: ["ADMIN"],
  },
  {
    title: "Interactions",
    description: "Track customer walk-ins, calls, and appointments.",
    href: "/app/interactions",
    roles: ["ADMIN"],
  },
  {
    title: "Leads",
    description: "Track and assign sales leads from campaigns and other sources.",
    href: "/app/leads",
    roles: ["ADMIN"],
  },
  {
    title: "B2B Proposals",
    description: "Build and manage business development proposals with custom pricing and images.",
    href: "/app/sales/proposals",
    roles: ["ADMIN", "MANAGER"],
  },
  {
    title: "Import HD Proposal",
    description: "Import a Hunter Douglas Direct Connect proposal PDF as a quote.",
    href: "/app/sales/import-hd",
    roles: ["ADMIN"],
  },
];

export default async function SalesHubPage() {
  await requirePage();
  return <CardGrid title="Sales" items={ITEMS} />;
}

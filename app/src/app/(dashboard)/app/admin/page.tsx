// /app/src/app/(dashboard)/app/admin/page.tsx
//
// Admin Tools hub -- App Router port of the legacy admin/index. MANAGER / ADMIN
// (mirrors the legacy withAuth roles). Cards self-filter by role via CardGrid;
// hrefs are unchanged so existing links keep working. Chrome from the
// (dashboard) layout. This is the main Admin hub linking every admin surface.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Content (CMS)",
    description: "Manage public pages, blog posts, and site navigation.",
    href: "/app/admin/cms",
    roles: ["ADMIN"],
  },
  {
    title: "Bookings",
    description: "View consultation bookings and the staff iCal subscription feed.",
    href: "/app/admin/bookings",
    roles: ["ADMIN"],
  },
  {
    title: "Scheduling",
    description: "Bookable services, weekly availability hours, and time off.",
    href: "/app/admin/scheduling",
    roles: ["ADMIN"],
  },
  {
    title: "Email",
    description: "Transactional email queue + SMTP status (booking + ticket notifications).",
    href: "/app/admin/email",
    roles: ["ADMIN"],
  },
  {
    title: "Settings",
    description: "Branding, theme colors, localization, modules, and integration keys.",
    href: "/app/admin/settings",
    roles: ["ADMIN"],
  },
  {
    title: "Vendor Pricing",
    description: "Import price books, manage grade pricing, and configure products.",
    href: "/app/admin/pricing",
  },
  {
    title: "Import Tools",
    description: "Upload and manage sales import data.",
    href: "/app/admin/import",
    roles: ["ADMIN"],
  },
  {
    title: "Export Data",
    description:
      "Download customers, products, orders, inventory, and more as CSV. Your data, anytime.",
    href: "/app/admin/export/data",
    roles: ["ADMIN"],
  },
  {
    title: "Setup",
    description: "Departments, printers, label templates and more.",
    href: "/app/admin/setup",
  },
  {
    title: "Gift Cards",
    description: "Look up balances, manage cards, and import the POS vouchers.",
    href: "/app/admin/gift-cards",
    roles: ["ADMIN"],
  },
  {
    title: "System Tools",
    description: "Reload data, system configuration, and diagnostics.",
    href: "/app/admin/tools",
    roles: ["ADMIN"],
  },
  {
    title: "Sales Goals",
    description: "Set annual goals and bonus rates per salesperson.",
    href: "/app/admin/sales/goals",
  },
  {
    title: "Monthly Sales Percentages",
    description: "Allocate annual goals across months.",
    href: "/app/admin/reports/monthly-percentages",
  },
  {
    title: "Salesperson Corrections",
    description: "Bulk update salesperson assignments and split-salesperson on orders.",
    href: "/app/admin/sales/salesperson-corrections",
  },
  {
    title: "Data Exports",
    description: "Download Windfall sales and customer CSV files.",
    href: "/app/admin/export/windfall",
    roles: ["ADMIN"],
  },
  {
    title: "Mailchimp Sync",
    description: "Run the automated Mailchimp pull and see sync history.",
    href: "/app/admin/automations/mailchimp-sync",
  },
  {
    title: "Customer AR Drift Check",
    description:
      "Cross-check stored Customer.openArBalance against the live source recompute. Flags any drift.",
    href: "/app/admin/automations/customer-ar-drift-check",
  },
  {
    title: "Login Activity",
    description: "See who's logged in right now and when each staff member last signed in.",
    href: "/app/admin/login-activity",
    roles: ["ADMIN"],
  },
];

export default async function AdminLandingPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CardGrid title="Admin Tools" items={ITEMS} />;
}

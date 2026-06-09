// /app/src/app/(dashboard)/app/admin/setup/page.tsx
//
// Setup Tools hub -- App Router port of the legacy admin/setup/index. MANAGER /
// ADMIN (mirrors the legacy withAuth roles). Cards self-filter by role via
// CardGrid; hrefs are unchanged so existing links keep working. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import CardGrid, { type CardGridItem } from "@/components/layout/CardGrid";

const ITEMS: CardGridItem[] = [
  {
    title: "Store Locations",
    description: "Manage stores, warehouses, and their addresses.",
    href: "/app/admin/setup/stores",
  },
  {
    title: "Staff Members",
    description: "Manage designers, register staff, and managers for the up-board rotation.",
    href: "/app/admin/staff",
  },
  {
    title: "Printers",
    description: "Manage Zebra and other label printers.",
    href: "/app/admin/setup/printers",
  },
  {
    title: "Registers",
    description: "Manage POS registers at each store location.",
    href: "/app/admin/setup/registers",
  },
  {
    title: "Label Templates",
    description: "Design and edit label layouts.",
    href: "/app/admin/setup/labels",
  },
  {
    title: "Tax Configuration",
    description: "Manage tax districts, groups, exempt reasons, and tax rules.",
    href: "/app/admin/setup/tax",
  },
  {
    title: "Chart of Accounts",
    description: "Manage GL accounts and account group mappings for QuickBooks export.",
    href: "/app/admin/setup/accounting",
  },
  {
    title: "Journal Entries",
    description: "Generate and export daily sales journal entries for QuickBooks.",
    href: "/app/admin/accounting/journal-entries",
  },
  {
    title: "Gift Card Presets",
    description: "Configure quick codes for gift card sales (GC, GC25, GC50).",
    href: "/app/admin/setup/gift-cards",
  },
  {
    title: "Database Backup",
    description: "Download a database backup or restore from a previous backup file.",
    href: "/app/admin/setup/database",
    roles: ["ADMIN"],
  },
  {
    title: "Service Settings",
    description: "Configure case types, statuses, and priorities.",
    href: "/app/admin/setup/service",
  },
  {
    title: "Installers",
    description: "Manage in-house and third-party installer roster.",
    href: "/app/admin/service/installers",
  },
  {
    title: "Delivery Zones",
    description: "Configure delivery zones, pricing, and ZIP code assignments.",
    href: "/app/admin/service/delivery-zones",
  },
  {
    title: "Vehicles",
    description: "Manage delivery trucks and vans.",
    href: "/app/admin/service/vehicles",
  },
  {
    title: "Email Templates",
    description: "Manage email templates for customer and team communication.",
    href: "/app/admin/setup/email-templates",
  },
  {
    title: "Nav Permissions",
    description: "Control which navigation sections each role can access.",
    href: "/app/admin/setup/permissions",
    roles: ["ADMIN"],
  },
  {
    title: "Trade Tiers",
    description: "Configure discount tiers for trade program customers.",
    href: "/app/admin/setup/trade-tiers",
  },
  {
    title: "Product Pairings",
    description:
      "Define which product categories belong together. Powers the Missing Pieces tile on the Opportunities hub.",
    href: "/app/admin/setup/product-pairings",
    roles: ["ADMIN", "MARKETING"],
  },
];

export default async function SetupToolsHubPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CardGrid title="Setup Tools" items={ITEMS} />;
}

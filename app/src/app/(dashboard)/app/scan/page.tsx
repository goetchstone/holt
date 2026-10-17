// /app/src/app/(dashboard)/app/scan/page.tsx
//
// The handheld's home: one large button per floor job (ledger plan phase 15).
// Each job's page checks its own permission; this menu is open to any staff
// member, since a driver (warehouse.operate) and a stock clerk
// (inventory.read) both start here.

import Link from "next/link";
import { requirePage } from "@/lib/auth/requirePage";

const JOBS = [
  {
    href: "/app/scan/lookup",
    title: "Look up",
    detail: "Scan anything: what it is and where it is",
  },
  { href: "/app/scan/receive", title: "Receive", detail: "Goods in against a purchase order" },
  { href: "/app/scan/move", title: "Put away and move", detail: "From one place to another" },
  { href: "/app/scan/pick", title: "Pick and load", detail: "A delivery run's pull list" },
  { href: "/app/scan/count", title: "Count", detail: "Count everything in one place" },
];

export default async function ScanMenuPage() {
  await requirePage();
  return (
    <div className="mx-auto max-w-lg space-y-3 font-serif">
      <h1 className="text-2xl font-semibold text-brand-blue">Scanner</h1>
      {JOBS.map((j) => (
        <Link
          key={j.href}
          href={j.href}
          className="block bg-white border border-brand-gray/20 rounded-lg px-4 py-4 shadow-sm"
        >
          <span className="block text-lg font-semibold text-brand-black">{j.title}</span>
          <span className="block text-sm text-brand-gray">{j.detail}</span>
        </Link>
      ))}
    </div>
  );
}

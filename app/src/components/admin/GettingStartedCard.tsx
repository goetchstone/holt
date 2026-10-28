// /app/src/components/admin/GettingStartedCard.tsx
//
// The getting-started checklist as a card at the top of the Admin hub: the
// items not yet done, each linking to the page where it is set. Renders
// nothing once every item is done. A server component -- the hub page passes
// the items it loaded (lib/gettingStartedServer.ts), so no client fetch.

import Link from "next/link";
import { remainingItems, type GettingStartedItem } from "@/lib/gettingStarted";

export function GettingStartedCard({ items }: Readonly<{ items: GettingStartedItem[] }>) {
  const remaining = remainingItems(items);
  if (remaining.length === 0) return null;
  return (
    <section
      aria-labelledby="getting-started-heading"
      className="rounded-lg border border-amber-300 bg-amber-50 p-5 shadow-md"
    >
      <h2 id="getting-started-heading" className="text-lg font-semibold text-brand-black">
        Getting started
      </h2>
      <p className="text-sm text-brand-gray">
        {remaining.length} of {items.length} still to do before your first sale.
      </p>
      <ul className="mt-3 space-y-3">
        {remaining.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="font-medium text-brand-blue underline-offset-2 hover:underline"
            >
              {item.label}
            </Link>
            {item.detail ? (
              <span className="block text-sm text-brand-gray">{item.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// /app/src/app/(dashboard)/app/admin/stock-ledger/page.tsx
//
// The stock ledger check (ledger plan phase 15): every place where what is on
// hand (InventoryPosition) is not the sum of its journal (StockMovement).
// Empty is the only right answer; a row means stock changed without a
// movement, or a movement was lost. The integration suite asserts the same
// after every test (jest.integration.afterEach.ts).

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { ledgerDrift } from "@/lib/inventory/ledger";

export default async function StockLedgerPage() {
  await requirePage(undefined, { permission: "inventory.adjust" });
  const [drift, movements, positions] = await Promise.all([
    ledgerDrift(prisma),
    prisma.stockMovement.count(),
    prisma.inventoryPosition.count(),
  ]);
  const ids = [...new Set(drift.map((d) => d.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, productNumber: true, name: true },
  });
  const places = await prisma.stockLocation.findMany({
    where: { id: { in: [...new Set(drift.map((d) => d.stockLocationId))] } },
    select: { id: true, name: true, storeLocation: { select: { name: true } } },
  });
  const product = new Map(products.map((p) => [p.id, p]));
  const place = new Map(places.map((p) => [p.id, p]));

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-brand-blue font-semibold">Stock ledger check</h1>
      <p className="text-sm text-brand-gray">
        {positions.toLocaleString()} stock rows, {movements.toLocaleString()} movements in the
        journal.
      </p>
      {drift.length === 0 ? (
        <p className="text-green-800 bg-green-50 border border-green-200 rounded p-3">
          Every place holds exactly what its journal says it should.
        </p>
      ) : (
        <>
          <p className="text-red-800 bg-red-50 border border-red-200 rounded p-3">
            {drift.length} place(s) disagree with their journal: stock changed without a movement
            being written.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-brand-gray border-b border-brand-gray/20">
                <th className="py-2 pr-3">Product</th>
                <th className="py-2 pr-3">Place</th>
                <th className="py-2 pr-3">Order</th>
                <th className="py-2 pr-3 text-right">Journal</th>
                <th className="py-2 text-right">On hand</th>
              </tr>
            </thead>
            <tbody>
              {drift.map((d) => (
                <tr
                  key={`${d.productId}:${d.stockLocationId}:${d.salesOrderId}`}
                  className="border-b border-brand-gray/10"
                >
                  <td className="py-2 pr-3">
                    {product.get(d.productId)?.name ?? d.productId}
                    <span className="block text-xs text-brand-gray">
                      {product.get(d.productId)?.productNumber}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {place.get(d.stockLocationId)?.name ?? d.stockLocationId}
                    <span className="block text-xs text-brand-gray">
                      {place.get(d.stockLocationId)?.storeLocation.name}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{d.salesOrderId ?? "free"}</td>
                  <td className="py-2 pr-3 text-right">{d.journal}</td>
                  <td className="py-2 text-right">{d.balance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

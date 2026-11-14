// /app/src/components/sales/RetailPriceTag.tsx
//
// The price beside a product in the POS and New Quote search results. A
// product with no retail price says so before anyone picks it, instead of
// showing nothing (or a stray "0") and refusing the line only after the click.
// `price` comes from catalogRetailPrice, so the tag and the refusal agree.
// During a scheduled sale (GAP-06 part B) `price` is the sale price and `sale`
// (catalogSale) carries the regular price, shown struck through beside it.

export function RetailPriceTag({
  price,
  sale = null,
  fmt,
}: Readonly<{
  price: number | null;
  sale?: { regularPrice: number } | null;
  fmt: (amount: number) => string;
}>) {
  if (price === null) {
    return (
      <span className="ml-3 whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
        No price
      </span>
    );
  }
  if (sale) {
    return (
      <span className="ml-3 whitespace-nowrap text-sm">
        <span className="sr-only">On sale, regular price </span>
        <s className="text-xs text-brand-gray">{fmt(sale.regularPrice)}</s>{" "}
        <span className="sr-only">, now </span>
        <span className="font-semibold text-red-700">{fmt(price)}</span>
      </span>
    );
  }
  return <span className="ml-3 whitespace-nowrap text-sm text-brand-black">{fmt(price)}</span>;
}

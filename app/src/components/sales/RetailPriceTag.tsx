// /app/src/components/sales/RetailPriceTag.tsx
//
// The price beside a product in the POS and New Quote search results. A
// product with no retail price says so before anyone picks it, instead of
// showing nothing (or a stray "0") and refusing the line only after the click.
// `price` comes from catalogRetailPrice, so the tag and the refusal agree.

export function RetailPriceTag({
  price,
  fmt,
}: Readonly<{ price: number | null; fmt: (amount: number) => string }>) {
  if (price === null) {
    return (
      <span className="ml-3 whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
        No price
      </span>
    );
  }
  return <span className="ml-3 whitespace-nowrap text-sm text-brand-black">{fmt(price)}</span>;
}

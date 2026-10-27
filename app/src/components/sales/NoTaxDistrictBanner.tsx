// /app/src/components/sales/NoTaxDistrictBanner.tsx
//
// Amber notice on the screens that ring sales (POS, New Quote) when the active
// store resolves no tax district -- neither its own nor the deployment default.
// resolveTaxRate.ts then charges 0% and only logs a warning; this puts the
// fact in front of the person ringing the sale. It never blocks the sale.
// `configured` comes from useActiveStore (pages/api/staff/active-store.ts);
// null means not known yet, and shows nothing.

export function NoTaxDistrictBanner({
  storeName,
  configured,
  className = "",
}: Readonly<{
  storeName: string | null | undefined;
  configured: boolean | null;
  className?: string;
}>) {
  if (configured !== false) return null;
  const where = storeName ? ` for ${storeName}` : "";
  return (
    <div
      role="status"
      className={`rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 ${className}`}
    >
      No tax district is configured{where} — sales here are charged 0% tax. Set one in Admin →
      Settings → Sales tax.
    </div>
  );
}

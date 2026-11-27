// /app/src/lib/sales/orderSeller.ts
//
// Who sold an order is two columns on SalesOrder: `salesPersonId`, the staff
// member, and `salesperson`, their name as text. An imported order has only
// the name (the import's sweep links it afterwards), so every reader matches
// either. An order written here knows the staff member, and writes both.
//
// Four writers wrote half: the register, Duplicate order and a house call
// wrote the name and no link, and a converted proposal the link and no name.
// The name alone still matches until the person's display name changes, and
// the duplicate-quote check, which tells two designers' quotes for one
// customer apart by the link, could not see those at all. The link alone
// leaves the order "Unassigned" in every list that reads the name.

/**
 * The two seller columns, to spread into a SalesOrder create or update.
 * `fallbackName` is for a session with no staff row (the register records the
 * signed-in email, so the sale still says who rang it).
 */
export function sellerColumns(
  staff: { id: number; displayName: string } | null | undefined,
  fallbackName: string | null = null,
): { salesPersonId: number | null; salesperson: string | null } {
  return {
    salesPersonId: staff?.id ?? null,
    salesperson: staff?.displayName || fallbackName,
  };
}

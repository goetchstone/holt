// /app/src/lib/returns/portalReturnContract.ts
//
// What the customer's return pages read about their return, and so all the
// public return routes send: GET /api/portal/returns/[token] and POST
// /api/portal/returns/request answer exactly this, and the request page
// (app/portal/return/[token]) and the status page (app/portal/return/status/
// [token]) read it. One definition, imported by both sides (rule 7). The token
// holder never gets the Return row itself. A field joins only when a page
// reads it: neither reads the reason, so it is not sent.
//
// Types only: no Prisma, so a client component can import it.

export interface PortalReturn {
  returnNumber: string;
  status: string;
  productName: string | null;
  quantity: number;
  /** ISO timestamp. */
  created: string;
  customerNotes: string | null;
}

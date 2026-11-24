// /app/src/lib/tickets/publicAuthor.ts
//
// Who the customer's no-login status page (/support/[token]) says wrote a
// message or added a file. It never names a member of staff: whatever staff
// did reads "Support" (pages/api/tickets/public/[token].ts).
//
// A message records its staff author in authorStaffId. A file has no such
// column: two routes write TicketAttachment.uploadedBy, and only the value
// tells them apart.
//
//   - the staff upload (pages/api/tickets/[id]/attachments.ts) records the
//     staff member's login email, or nothing;
//   - the customer's upload (pages/api/tickets/public/[token]/attachment.ts)
//     records customerUploaderName below.
//
// So a file shows its uploader only when the value is exactly the name the
// customer's upload records for that ticket, and "Support" otherwise: a value
// this does not recognise is never shown. That name is the ticket's submitter
// name, which the public form requires and nothing changes later, so it is the
// name the upload recorded. A ticket without one falls back to its customer's
// name; if that is edited afterwards, the file reads "Support", never anyone
// else's name.

/** What the customer's status page calls any member of staff. */
export const PUBLIC_STAFF_NAME = "Support";

export interface TicketSubmitter {
  submitterName: string | null;
  customer: { firstName: string | null; lastName: string | null } | null;
}

/** The name the customer's own upload records as a file's uploadedBy. */
export function customerUploaderName(ticket: TicketSubmitter): string {
  return (
    ticket.submitterName ||
    [ticket.customer?.firstName, ticket.customer?.lastName].filter(Boolean).join(" ") ||
    "Customer"
  );
}

/** A file's uploader as the customer's status page shows it. */
export function publicUploaderName(uploadedBy: string | null, ticket: TicketSubmitter): string {
  const customer = customerUploaderName(ticket);
  return uploadedBy === customer ? customer : PUBLIC_STAFF_NAME;
}

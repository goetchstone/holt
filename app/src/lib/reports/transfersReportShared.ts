// /app/src/lib/reports/transfersReportShared.ts
//
// What the Transfers report can show (lib/reports/transfersReport.ts), which its
// screen reads too. Pure, so the screen can import it without the database
// (rule 7).

export const TRANSFER_VIEWS = {
  moved: { label: "Moved", statuses: ["IN_TRANSIT", "RECEIVED"] },
  in_transit: { label: "On the way now", statuses: ["IN_TRANSIT"] },
  received: { label: "Received", statuses: ["RECEIVED"] },
  draft: { label: "Not sent yet", statuses: ["DRAFT"] },
  cancelled: { label: "Cancelled", statuses: ["CANCELLED"] },
} as const;
export type TransferView = keyof typeof TRANSFER_VIEWS;

export const TRANSFER_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Not sent yet",
  IN_TRANSIT: "On the way",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

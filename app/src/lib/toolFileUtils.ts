// /app/src/lib/toolFileUtils.ts
//
// Small client-side helpers shared by the files-and-forms Tools pages
// (Home Accessory Order Import today; any future files-based tool
// tomorrow): currency display, filename slugs, browser file downloads
// (xlsx + csv), and safe server-error reads.
//
// Ported from furniture-configurator's src/lib/toolFileUtils.ts. FC's tools
// download Ordorite import CSVs/XLSX as their end product (Ordorite is
// FC's system of record); holt's Home Accessory Order Import tool instead
// creates BuyerDraftPurchaseOrder + BuyerDraftItem rows directly (holt IS
// its own system of record — see homeAccessoryBuyerDraftMapping.ts), so it
// doesn't call downloadCsv/downloadXlsx itself. They're kept here anyway:
// they're generic (no Ordorite-specific shape baked in beyond the
// ExportCell type below), and any future tool that DOES need a
// spreadsheet/CSV download (or the buyer-drafts workbench's own export
// buttons, which currently duplicate a Blob-download one-liner inline) can
// reuse them instead of re-implementing.

import * as XLSX from "xlsx";

/** A single spreadsheet cell value — kept generic rather than importing
 *  FC's Ordorite-specific row types, since holt has no Ordorite export. */
export type ExportCell = string | number;

export function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

export function fileSlug(s: string): string {
  return (
    s
      .replaceAll(/[^a-z0-9]+/gi, "-")
      .replaceAll(/^-+|-+$/g, "")
      .toLowerCase() || "order"
  );
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Download a spreadsheet as a real .xlsx workbook. Numbers are written as
 * numeric cells, not text — a downstream importer reads the cell value,
 * and a text-formatted price is the classic way a spreadsheet silently
 * mangles money on the way in.
 */
export function downloadXlsx(
  filename: string,
  headers: readonly string[],
  rows: readonly ExportCell[][],
  sheetName = "Sheet1",
) {
  const sheet = XLSX.utils.aoa_to_sheet([[...headers], ...rows.map((r) => [...r])]);
  const book = XLSX.utils.book_new();
  // Excel caps sheet names at 31 chars and rejects []:*?/\ — keep it safe.
  XLSX.utils.book_append_sheet(book, sheet, sheetName.slice(0, 31));
  XLSX.writeFile(book, filename);
}

/**
 * Server error message from a failed fetch response. A crashed endpoint can
 * return HTML (or an empty body), and trying to blindly `res.json()` it
 * throws its own unhelpful parse error — this always resolves to SOME
 * readable string, falling back through: server's `{ error }` body -> the
 * server's `{ message }` body -> the HTTP status line -> the generic
 * fallback the caller supplied.
 */
export async function readServerError(res: Response, fallback: string): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return `${fallback} (HTTP ${res.status} ${res.statusText || ""}`.trimEnd() + ")";
  }
  if (body && typeof body === "object") {
    const maybe = (body as { error?: unknown }).error ?? (body as { message?: unknown }).message;
    if (typeof maybe === "string" && maybe.trim()) return maybe;
  }
  return `${fallback} (HTTP ${res.status} ${res.statusText || ""}`.trimEnd() + ")";
}

// /app/src/lib/pricing/pdfUtils.ts
//
// Shared PDF parsing utilities used by vendor-specific extractors.
// Contains the column-aware page renderer and common helper functions.

import pdf from "pdf-parse";

/**
 * pdf-parse, handed the file as a plain Uint8Array copy.
 *
 * pdf-parse bundles pdf.js 1.10 (2017), written for plain typed arrays. Handed
 * a Node Buffer it can misread the file ("bad XRef entry", warnings about bytes
 * that are not in it): seen on Node 20 for small files and under Jest on Node
 * 24, which CI runs. The same bytes as a plain Uint8Array read correctly on
 * both. The copy is one pass over a few MB.
 */
export function parsePdf(bytes: Uint8Array, options?: Record<string, unknown>) {
  return pdf(new Uint8Array(bytes), options);
}

// ─── Column-aware PDF text extraction ─────────────────────────────

/**
 * Custom page renderer that preserves column positions.
 *
 * pdf-parse's default renderer concatenates text items without
 * preserving spatial layout. This renderer groups text items by
 * Y-coordinate (row), sorts by X-coordinate, and inserts tab
 * characters when there's a horizontal gap > threshold between items.
 *
 * This turns:  "STYLE NUMBER1952626667707577"
 * Into:        "STYLE NUMBER\t19\t52\t62\t66\t67\t70\t75\t77"
 */
export function columnAwarePageRenderer(pageData: PdfPageProxy): Promise<string> {
  return pageData.getTextContent({ normalizeWhitespace: false }).then((textContent) => {
    const rows: Record<number, { x: number; str: string; w: number }[]> = {};

    // Merge Y coordinates within 3 units to prevent items on the same visual
    // line from splitting into separate rows due to sub-point rendering offsets
    // (e.g. Wesley Hall leather pages have style names at y=660 and y=661).
    const Y_MERGE = 3;

    for (const item of textContent.items) {
      const rawY = Math.round(item.transform[5]);
      const x = Math.round(item.transform[4]);

      // Snap to an existing nearby Y row if one exists within threshold
      let y = rawY;
      for (const existingY of Object.keys(rows).map(Number)) {
        if (Math.abs(existingY - rawY) <= Y_MERGE) {
          y = existingY;
          break;
        }
      }

      if (!rows[y]) rows[y] = [];
      rows[y].push({ x, str: item.str, w: item.width });
    }

    // Sort rows top-to-bottom (PDF Y is bottom-up, so descending)
    const sortedYs = Object.keys(rows)
      .map(Number)
      .sort((a, b) => b - a);

    let output = "";
    for (const y of sortedYs) {
      const items = rows[y].sort((a, b) => a.x - b.x);
      let line = "";
      let lastEnd = 0;
      for (const item of items) {
        if (lastEnd > 0 && item.x - lastEnd > 5) {
          line += "\t";
        }
        line += item.str;
        lastEnd = item.x + item.w;
      }
      output += line + "\n";
    }
    return "\f<<PAGE:" + pageData.pageNumber + ">>\n" + output;
  });
}

/**
 * Extract all text from a PDF using the column-aware renderer.
 * Strips page-break markers (\f) added by the renderer.
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  const data = await parsePdf(pdfBuffer, {
    pagerender: columnAwarePageRenderer,
  });
  return data.text.replace(/\f(<<PAGE:\d+>>\n)?/g, "");
}

/**
 * Extract all text from a PDF, preserving page markers.
 * Returns text with `<<PAGE:N>>` at the start of each page's content.
 * Callers can split on `/<<PAGE:(\d+)>>\n/` to get page-annotated text.
 */
export async function extractPdfTextWithPages(pdfBuffer: Buffer): Promise<string> {
  const data = await parsePdf(pdfBuffer, {
    pagerender: columnAwarePageRenderer,
  });
  return data.text.replace(/\f/g, "");
}

// ─── Positioned text items ────────────────────────────────────────

/** One positioned text run from the PDF: x/y from its transform, glyph width, string, page. */
export interface PdfTextItem {
  /** PDF user-space x of the run's origin, in points. */
  x: number;
  /** PDF user-space y of the baseline, in points -- measured UP from the page bottom. */
  y: number;
  /** Width of the run, in points. */
  w: number;
  s: string;
  /** 1-based, the same numbering as the `<<PAGE:N>>` markers above. */
  page: number;
}

interface PdfTextRun {
  transform: number[];
  width: number;
  str: string;
}

/** The part of pdf.js's page proxy that pdf-parse hands `pagerender` and this reads. */
interface PdfPageProxy {
  pageNumber: number;
  getTextContent(opts: { normalizeWhitespace: boolean }): Promise<{ items: PdfTextRun[] }>;
}

/**
 * Every text run in a PDF, with its position and page.
 *
 * The tab-inserting renderer above keeps a line's order but throws away WHERE on
 * the line each piece sat, so a column that wraps onto a second line -- a style
 * name printed in two lines under its column -- cannot be put back under the
 * right column. Readers that need that reconstruct columns from these
 * coordinates instead. Ported from the sibling repo's pdfUtils (no vendor data).
 */
export async function readPdfTextItems(pdfBuffer: Buffer): Promise<PdfTextItem[]> {
  const items: PdfTextItem[] = [];
  await parsePdf(pdfBuffer, {
    pagerender: (pageData: PdfPageProxy) =>
      pageData.getTextContent({ normalizeWhitespace: false }).then((content) => {
        for (const it of content.items) {
          items.push({
            x: it.transform[4],
            y: it.transform[5],
            w: it.width,
            s: it.str,
            page: pageData.pageNumber,
          });
        }
        return "";
      }),
  });
  return items;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Split a tab-delimited line after removing its label prefix.
 */
export function splitTabs(line: string, label: string): string[] {
  const startIdx = line.indexOf(label) + label.length;
  const remainder = line.substring(startIdx);
  return remainder
    .replace(/^\t/, "")
    .split("\t")
    .map((v) => v.trim());
}

/**
 * Find the previous non-empty line (looking backward from index).
 */
export function findPrevNonEmptyLine(lines: string[], fromIndex: number): string | null {
  for (let j = fromIndex - 1; j >= Math.max(0, fromIndex - 3); j--) {
    const l = lines[j].trim();
    if (l) return l;
  }
  return null;
}

/**
 * Find the next non-empty line (looking forward from index).
 */
export function findNextNonEmptyLine(lines: string[], fromIndex: number): string | null {
  for (let j = fromIndex + 1; j < Math.min(lines.length, fromIndex + 3); j++) {
    const l = lines[j].trim();
    if (l) return l;
  }
  return null;
}

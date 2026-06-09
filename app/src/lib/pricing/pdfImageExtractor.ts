// /app/src/lib/pricing/pdfImageExtractor.ts
//
// Extracts embedded images (line drawings) from PDF pages using Poppler's
// `pdfimages` CLI tool. Returns a Map of pageNumber → image file path.
//
// Wesley Hall wholesale PDFs contain product line drawing images embedded as
// XObject images. Poppler extracts all 2000+ images from a 100-page PDF in
// ~2 seconds, vs 300+ seconds with pdfjs-dist.
//
// Images are sorted by X-position (left-to-right) using pdfjs-dist to read
// the rendering coordinates, because Poppler's stream order doesn't match
// the visual layout order.

import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";
import { getErrorMessage } from "@/lib/toastError";

const execFileAsync = promisify(execFile);

/** Minimum pixel dimension to consider an image a line drawing (skip tiny icons).
 *  Product line drawings are typically 60+ pixels in both dimensions. Images
 *  smaller than this threshold are decorative elements, bullets, or noise. */
const MIN_IMAGE_DIMENSION_PX = 40;

/** Cached resolved path to the pdfimages binary. */
let cachedPdfImagesBin: string | null = null;

/**
 * Find the `pdfimages` binary. Tries well-known locations first, then falls
 * back to `which`. Caches the result for subsequent calls.
 */
async function findPdfImagesBin(): Promise<string> {
  if (cachedPdfImagesBin) return cachedPdfImagesBin;

  const candidates = [
    "/usr/bin/pdfimages", // Alpine / Debian / Ubuntu (Docker)
    "/opt/homebrew/bin/pdfimages", // macOS Homebrew (Apple Silicon)
    "/usr/local/bin/pdfimages", // macOS Homebrew (Intel) / manual install
  ];

  for (const p of candidates) {
    try {
      await fs.access(p);
      cachedPdfImagesBin = p;
      return p;
    } catch {
      // not found at this path, try next
    }
  }

  // Fallback: try `which`
  try {
    const { stdout } = await execFileAsync("which", ["pdfimages"]);
    const trimmed = stdout.trim();
    if (trimmed) {
      cachedPdfImagesBin = trimmed;
      return trimmed;
    }
  } catch {
    // which failed
  }

  throw new Error(
    "pdfimages not found. Install poppler-utils: apk add poppler-utils (Alpine) or brew install poppler (macOS).",
  );
}

export interface ExtractedPageImage {
  pageNumber: number;
  filePath: string; // Absolute path to extracted image file
  ext: string; // File extension (jpg, ppm, png, etc.)
}

export interface PageDiagnostic {
  pageNumber: number;
  imageCount: number;
  filteredIndicesCount: number;
  positionCount: number;
  rowFilteredCount: number;
  overlapFilteredCount: number;
  sortMethod: "position" | "fallback";
  positions: Array<{ x: number; y: number }>;
  /** Rendered widths of final images in PDF points, for merged-image detection. */
  imageWidths: number[];
}

export interface ExtractImagesResult {
  images: Map<number, ExtractedPageImage[]>;
  /** The raw minimum page number found in pdfimages output (0 = 0-based, 1 = 1-based). */
  rawPageBase: number;
  /** Per-page alignment diagnostics for debugging image-to-style mapping. */
  diagnostics: PageDiagnostic[];
}

interface ImageFilterResult {
  /** Set of "page-num" keys for images that pass all filters. */
  keys: Set<string>;
  /** Per-page indices: among all type="image" entries on a page, which
   *  sequential indices passed the dimension filter. Used to align pdfjs
   *  X positions (which include ALL images) with the filtered subset. */
  filteredIndices: Map<number, number[]>;
  /** Per-page cross-page mask: for each entry in filteredIndices[page],
   *  whether that image's object ID also appears on a different page.
   *  Used to prefer removing cross-page references from overlap groups. */
  crossPageMask: Map<number, boolean[]>;
}

/**
 * Run `pdfimages -list` to classify image entries. Returns the set of
 * (page, num) keys that pass filtering, plus per-page index tracking so
 * we can align with pdfjs X positions. The -list output columns:
 *   0=page, 1=num, 2=type, 3=width, 4=height, ...
 *
 * pdfjs-dist fires paintImageXObject once per type="image" entry (soft
 * masks are applied internally). So the Nth paintImageXObject on a page
 * corresponds to the Nth type="image" row in pdfimages -list. Tracking
 * which of those indices pass our dimension filter lets us select the
 * matching X positions even when some images are filtered out.
 */
async function getImageKeys(pdfimagesBin: string, pdfPath: string): Promise<ImageFilterResult> {
  const { stdout } = await execFileAsync(pdfimagesBin, ["-list", pdfPath], { timeout: 120_000 });
  const lines = stdout.split("\n");

  // Pass 1: identify which object IDs appear on multiple pages.
  const objectPages = new Map<string, Set<number>>();
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 11) continue;
    const page = Number.parseInt(cols[0], 10);
    if (isNaN(page)) continue;
    if (cols[2] !== "image") continue;
    const objectId = cols[10];
    if (!objectPages.has(objectId)) objectPages.set(objectId, new Set());
    objectPages.get(objectId)!.add(page);
  }

  const crossPageObjectIds = new Set<string>();
  for (const [objId, pages] of objectPages) {
    if (pages.size > 1) crossPageObjectIds.add(objId);
  }

  // Pass 2: build keys, filteredIndices, and crossPageMask.
  const keys = new Set<string>();
  const filteredIndices = new Map<number, number[]>();
  const crossPageMask = new Map<number, boolean[]>();
  const imageCountByPage = new Map<number, number>();
  const seenObjectIds = new Map<number, Set<string>>();

  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 11) continue;
    const page = Number.parseInt(cols[0], 10);
    const num = Number.parseInt(cols[1], 10);
    if (isNaN(page) || isNaN(num)) continue;
    if (cols[2] !== "image") continue;

    const idx = imageCountByPage.get(page) || 0;
    imageCountByPage.set(page, idx + 1);

    const objectId = cols[10];
    if (!seenObjectIds.has(page)) seenObjectIds.set(page, new Set());
    const pageObjects = seenObjectIds.get(page)!;
    if (pageObjects.has(objectId)) continue;
    pageObjects.add(objectId);

    const w = Number.parseInt(cols[3], 10);
    const h = Number.parseInt(cols[4], 10);
    // Column 7 = bits per component. 1-bpc images are binary rasters
    // (construction diagrams, assembly illustrations) not product line drawings.
    const bpc = Number.parseInt(cols[7], 10);
    if (w >= MIN_IMAGE_DIMENSION_PX && h >= MIN_IMAGE_DIMENSION_PX && bpc > 1) {
      keys.add(`${page}-${num}`);
      if (!filteredIndices.has(page)) filteredIndices.set(page, []);
      filteredIndices.get(page)!.push(idx);
      if (!crossPageMask.has(page)) crossPageMask.set(page, []);
      crossPageMask.get(page)!.push(crossPageObjectIds.has(objectId));
    }
  }

  return { keys, filteredIndices, crossPageMask };
}

// ─── pdfjs-dist CTM helpers for image X-position sorting ─────────

type CTM = [number, number, number, number, number, number];

/** Multiply two 6-element affine transform matrices. */
function mulCTM(m1: CTM, m2: CTM): CTM {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// pdfjs-dist OPS constants
const OPS_SAVE = 10;
const OPS_RESTORE = 11;
const OPS_TRANSFORM = 12;
const OPS_PAINT_IMAGE_XOBJECT = 85;

/** Minimum rendered dimension (PDF points) for an image to be considered visible.
 *  Images with CTM-derived width or height below this are invisible on the page
 *  even though their intrinsic pixel dimensions may pass the 40px filter. */
const MIN_RENDERED_PT = 5;

interface ImagePosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Use pdfjs-dist to get the (x, y) position of each image on the given pages.
 * Returns a Map of pageNumber → array of positions in rendering order.
 *
 * Poppler's pdfimages outputs images in content stream order, which doesn't
 * match the visual left-to-right layout. pdfjs-dist's getOperatorList()
 * walks the same content stream but gives us the CTM at each image paint
 * operation, so we can extract both X and Y translations.
 *
 * Only tracks paintImageXObject (opcode 85) which corresponds to the
 * type="image" entries in pdfimages -list. Inline images (86) and image
 * masks (83) are NOT counted by pdfimages as type="image", so including
 * them would break the index alignment with filteredIndices.
 */
async function getImagePositions(
  pdfBuffer: Buffer,
  pageNumbers: number[],
): Promise<Map<number, ImagePosition[]>> {
  // pdfjs-dist v4 only ships ESM; dynamic import required for CJS compatibility
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  const result = new Map<number, ImagePosition[]>();

  for (const pageNum of pageNumbers) {
    if (pageNum < 1 || pageNum > doc.numPages) continue;

    const page = await doc.getPage(pageNum);
    const ops = await page.getOperatorList();

    const ctmStack: CTM[] = [];
    let ctm: CTM = [1, 0, 0, 1, 0, 0];
    const positions: ImagePosition[] = [];

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS_SAVE) {
        ctmStack.push([...ctm] as CTM);
      } else if (fn === OPS_RESTORE) {
        ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS_TRANSFORM) {
        const args = ops.argsArray[i] as number[];
        ctm = mulCTM(ctm, args as CTM);
      } else if (fn === OPS_PAINT_IMAGE_XOBJECT) {
        positions.push({ x: ctm[4], y: ctm[5], w: Math.abs(ctm[0]), h: Math.abs(ctm[3]) });
      }
    }

    result.set(pageNum, positions);
    page.cleanup();
  }

  doc.destroy();
  return result;
}

/** Y-gap threshold (PDF units) for separating image rows. Product images in the
 *  same row vary by 20-50 units (CTM bottom-left origin causes height-dependent
 *  offsets). Stray images at different vertical positions differ by 200+. */
const ROW_GAP_THRESHOLD = 100;

/**
 * Filter to the largest cluster of images sharing a similar Y-position.
 * Splits images into groups at Y-gaps > ROW_GAP_THRESHOLD and returns the
 * group with the most members (the product image row). This removes stray
 * images embedded at different vertical positions without affecting the
 * left-to-right ordering within the product row.
 */
function filterToProductRow<T extends { y: number }>(items: T[]): T[] {
  if (items.length <= 1) return items;

  const sorted = [...items].sort((a, b) => a.y - b.y);
  const groups: T[][] = [];
  let current: T[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - sorted[i - 1].y) > ROW_GAP_THRESHOLD) {
      groups.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  groups.push(current);

  if (groups.length === 0) return [];
  return groups.reduce<(typeof groups)[number]>(
    (best, g) => (g.length > best.length ? g : best),
    groups[0],
  );
}

/**
 * Remove ghost images from X-sorted overlap groups when the image count exceeds
 * the expected style count. Ghost images overlap with real product images at
 * nearly the same X-position but have smaller rendered widths. From each overlap
 * chain (where img[i].x < img[i-1].x + img[i-1].w), the smallest-width member
 * is removed. Repeats until count matches expected or no overlaps remain.
 */
function removeOverlappingGhosts<T extends { x: number; w: number }>(
  items: T[],
  expectedCount: number,
): T[] {
  if (items.length <= expectedCount) return items;
  const result = [...items];

  while (result.length > expectedCount) {
    // Find overlap groups: connected components where right edge > next x
    const groups: number[][] = [];
    let group: number[] = [0];
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1];
      if (result[i].x < prev.x + prev.w) {
        group.push(i);
      } else {
        if (group.length > 1) groups.push(group);
        group = [i];
      }
    }
    if (group.length > 1) groups.push(group);
    if (groups.length === 0) break;

    // From the largest overlap group, remove the smallest-width member.
    // groups.length >= 1 is guaranteed by the break above.
    const biggest = groups.reduce<(typeof groups)[number]>(
      (a, b) => (a.length >= b.length ? a : b),
      groups[0],
    );
    let minIdx = biggest[0];
    for (const idx of biggest) {
      if (result[idx].w < result[minIdx].w) minIdx = idx;
    }
    result.splice(minIdx, 1);
  }
  return result;
}

/**
 * Extract embedded images from a PDF buffer using Poppler's `pdfimages` CLI.
 *
 * Returns a Map of pageNumber → array of images for that page, sorted by
 * X-position (left-to-right visual order). Uses `-png` to convert all image
 * formats to PNG, filters by pixel dimensions, excludes soft masks, then
 * reorders using pdfjs-dist to match visual layout.
 *
 * Auto-detects whether pdfimages outputs 0-based or 1-based page numbers
 * and normalizes to 1-based to match the text extractor convention.
 */
export async function extractPdfImages(
  pdfBuffer: Buffer,
  expectedCountByPage?: Map<number, number>,
): Promise<ExtractImagesResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-img-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  await fs.writeFile(pdfPath, pdfBuffer);

  const pdfimagesBin = await findPdfImagesBin();

  // Identify which (page, num) entries are real images vs soft masks,
  // plus per-page index tracking for X-position alignment
  const {
    keys: imageKeys,
    filteredIndices,
    crossPageMask,
  } = await getImageKeys(pdfimagesBin, pdfPath);

  try {
    // -png: extract all images as PNG (handles JPEG + indexed-color + raw RGB)
    // -p: include page number in output filenames (img-{page}-{num}.png)
    // 300s timeout: Synology NAS hardware is slower; large PDFs (600+ images)
    // can take 30-60s on production vs ~2s on fast dev machines.
    await execFileAsync(pdfimagesBin, ["-png", "-p", pdfPath, path.join(tmpDir, "img")], {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const rawStderr =
      typeof err === "object" && err !== null && "stderr" in err
        ? (err as { stderr?: unknown }).stderr
        : undefined;
    const stderr = rawStderr ? ` stderr: ${String(rawStderr)}` : "";
    throw new Error(`pdfimages failed: ${getErrorMessage(err, "unknown error")}${stderr}`);
  }

  await fs.unlink(pdfPath).catch(() => {});

  const files = await fs.readdir(tmpDir);

  // Filename format with -png: img-{page}-{seq}.png (all files are PNG)
  const pageFileRegex = /^img-(\d+)-(\d+)\.png$/i;

  // First pass: collect raw page numbers from filenames
  const rawPageImages = new Map<number, { filePath: string; ext: string; seq: number }[]>();

  for (const file of files) {
    const match = file.match(pageFileRegex);
    if (!match) continue;

    const rawPageNum = Number.parseInt(match[1], 10);
    const seq = Number.parseInt(match[2], 10);

    // Skip soft masks and images below the pixel dimension threshold
    if (!imageKeys.has(`${rawPageNum}-${seq}`)) continue;

    const filePath = path.join(tmpDir, file);

    if (!rawPageImages.has(rawPageNum)) {
      rawPageImages.set(rawPageNum, []);
    }
    rawPageImages.get(rawPageNum)!.push({ filePath, ext: "png", seq });
  }

  // Auto-detect: pdfimages -p may use 0-based or 1-based page numbers
  // depending on poppler version. Text extraction uses 1-based (i + 1).
  const allRawPages = Array.from(rawPageImages.keys());
  const rawPageBase = allRawPages.length > 0 ? Math.min(...allRawPages) : 0;
  const pageOffset = rawPageBase === 0 ? 1 : 0;

  // Get (x, y) positions from pdfjs-dist so we can sort images left-to-right.
  // pdfimages outputs in content stream order which doesn't match visual order.
  const normalizedPages = allRawPages.map((rp) => rp + pageOffset);
  const positionsByPage = await getImagePositions(pdfBuffer, normalizedPages);

  // Build result with normalized 1-based page numbers, sorted by X position
  const images = new Map<number, ExtractedPageImage[]>();
  const diagnostics: PageDiagnostic[] = [];

  for (const [rawPage, imgs] of rawPageImages) {
    const pageNum = rawPage + pageOffset;

    // Sort by stream sequence first (matches pdfjs rendering order)
    imgs.sort((a, b) => a.seq - b.seq);

    const allPositions = positionsByPage.get(pageNum);
    const indices = filteredIndices.get(rawPage);

    const pageCrossPage = crossPageMask.get(rawPage);

    if (allPositions && indices && indices.length === imgs.length) {
      const paired = imgs.map((img, i) => {
        const pos =
          indices[i] < allPositions.length ? allPositions[indices[i]] : { x: 0, y: 0, w: 0, h: 0 };
        const isCrossPage = pageCrossPage?.[i] ?? false;
        return { img, x: pos.x, y: pos.y, w: pos.w, h: pos.h, isCrossPage };
      });

      // Layer 1: Remove images rendered at near-zero size. These exist in the
      // PDF structure but are invisible on the page (e.g. cross-page XObject
      // references squeezed to zero width by a degenerate CTM).
      const visible = paired.filter((p) => p.w >= MIN_RENDERED_PT && p.h >= MIN_RENDERED_PT);

      // Layer 2: Filter to the main product row by Y-position clustering.
      const rowFiltered = filterToProductRow(visible);

      // Sort left-to-right within the product row
      rowFiltered.sort((a, b) => a.x - b.x);

      // Layer 3: Remove ghost images from X-overlap groups when expected count is known.
      const expectedCount = expectedCountByPage?.get(pageNum);
      const final =
        expectedCount !== undefined
          ? removeOverlappingGhosts(rowFiltered, expectedCount)
          : [...rowFiltered];

      // Layer 4: Trim excess images when count exceeds expected.
      // Prefer removing cross-page images first (smallest width), then
      // fall back to removing the smallest overall image.
      if (expectedCount !== undefined && final.length > expectedCount) {
        while (final.length > expectedCount) {
          const crossPageItems = final
            .map((item, idx) => ({ idx, w: item.w, isCrossPage: item.isCrossPage }))
            .filter((e) => e.isCrossPage)
            .sort((a, b) => a.w - b.w);
          if (crossPageItems.length > 0) {
            final.splice(crossPageItems[0].idx, 1);
            continue;
          }
          let minIdx = 0;
          for (let j = 1; j < final.length; j++) {
            if (final[j].w < final[minIdx].w) minIdx = j;
          }
          final.splice(minIdx, 1);
        }
      }

      const rowRemoved = paired.length - rowFiltered.length;
      const overlapRemoved = rowFiltered.length - final.length;

      diagnostics.push({
        pageNumber: pageNum,
        imageCount: imgs.length,
        filteredIndicesCount: indices.length,
        positionCount: allPositions.length,
        rowFilteredCount: rowRemoved,
        overlapFilteredCount: overlapRemoved,
        sortMethod: "position",
        positions: final.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })),
        imageWidths: final.map(({ w }) => Math.round(w)),
      });

      images.set(
        pageNum,
        final.map(({ img }) => ({
          pageNumber: pageNum,
          filePath: img.filePath,
          ext: img.ext,
        })),
      );
    } else {
      diagnostics.push({
        pageNumber: pageNum,
        imageCount: imgs.length,
        filteredIndicesCount: indices?.length ?? 0,
        positionCount: allPositions?.length ?? 0,
        rowFilteredCount: 0,
        overlapFilteredCount: 0,
        sortMethod: "fallback",
        positions: [],
        imageWidths: [],
      });

      images.set(
        pageNum,
        imgs.map((img) => ({
          pageNumber: pageNum,
          filePath: img.filePath,
          ext: img.ext,
        })),
      );
    }
  }

  return { images, rawPageBase, diagnostics };
}

/**
 * Save extracted images to the output directory, mapping styles to image URLs.
 *
 * For each page, matches images to styles by position (image[0] → style[0], etc.).
 * When a page has fewer images than styles, remaining styles get no image (to
 * avoid assigning an incorrect drawing).
 * Returns a Map of styleNumber → public URL path.
 */
export async function savePageImages(
  images: Map<number, ExtractedPageImage[]>,
  outputDir: string,
  stylesByPage: Map<number, string[]>,
): Promise<Map<string, string>> {
  await fs.mkdir(outputDir, { recursive: true });

  const styleImageMap = new Map<string, string>();
  const tmpDirs = new Set<string>();

  // Process pages in ascending order so product pages (later in the PDF)
  // override any intro/index pages that reference the same style number.
  const sortedPages = Array.from(images.entries()).sort((a, b) => a[0] - b[0]);

  for (const [pageNum, pageImages] of sortedPages) {
    const styles = stylesByPage.get(pageNum) || [];
    if (styles.length === 0 || pageImages.length === 0) continue;

    tmpDirs.add(path.dirname(pageImages[0].filePath));

    for (let i = 0; i < styles.length; i++) {
      if (i >= pageImages.length) continue;
      const image = pageImages[i];
      const styleNumber = styles[i];
      const ext = image.ext;
      // Sanitize style numbers that contain slashes (e.g., "1490-L/R").
      // safePathJoin below provides defense in depth against any other
      // path-traversal chars that leak through styleNumber.
      const safeStyleNumber = styleNumber.replace(/\//g, "-");
      const fileName = `${safeStyleNumber}.${ext}`;
      let destPath: string;
      try {
        destPath = safePathJoin(outputDir, fileName);
      } catch (err) {
        if (err instanceof PathTraversalError) continue; // skip the file
        throw err;
      }

      await fs.copyFile(image.filePath, destPath);

      const urlPath = `/uploads/line-drawings/${path.basename(outputDir)}/${fileName}?v=${Date.now()}`;
      styleImageMap.set(styleNumber, urlPath);
    }
  }

  for (const tmpDir of tmpDirs) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return styleImageMap;
}

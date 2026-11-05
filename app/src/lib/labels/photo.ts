// /app/src/lib/labels/photo.ts
//
// A product's picture on a tag (GAP-18). A thermal head prints black or nothing,
// so the picture is shrunk to the size the template gives it (photoDots, its
// longest side) and dithered to one bit, then written as a ZPL graphic field.
// The template places it: ^FO30,30{{photo}}^FS.
//
// Only a picture Holt holds is read (/uploads/...), from under the upload folder.
// A picture at another address isn't fetched, so a tag can't be made to call out
// to one. No picture, or one that can't be read, leaves the field empty and the
// tag still prints: a missing picture shouldn't hold up a receipt.

import path from "node:path";
import sharp from "sharp";
import { logger } from "@/lib/logger";
import { UPLOAD_ROOT } from "@/lib/secureUpload";
import { ZplGraphic } from "./renderTemplate";

/** Largest side a template may ask for: a little over 9 inches at 203 dots per inch. */
export const PHOTO_DOTS_MAX = 2000;

/** Why this can't be a template's photo size, or null. Null means no photo. */
export function photoDotsProblem(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > PHOTO_DOTS_MAX
  ) {
    return `The photo size must be a whole number of dots from 1 to ${PHOTO_DOTS_MAX}, or empty for no photo.`;
  }
  return null;
}

/**
 * Floyd-Steinberg: each pixel's rounding error is passed to its neighbours, so a
 * grey area comes out as a pattern of dots rather than a solid block. Takes one
 * greyscale byte per pixel and answers true for a pixel that prints.
 */
export function ditherToDots(grey: Uint8Array, width: number, height: number): boolean[] {
  const levels = Float32Array.from(grey);
  const dots = new Array<boolean>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const prints = levels[i] < 128;
      dots[i] = prints;
      const error = levels[i] - (prints ? 0 : 255);
      // Never around a row's edge onto another row. Past the last row, a typed
      // array ignores the write.
      if (x + 1 < width) levels[i + 1] += (error * 7) / 16;
      if (x > 0) levels[i + width - 1] += (error * 3) / 16;
      levels[i + width] += (error * 5) / 16;
      if (x + 1 < width) levels[i + width + 1] += error / 16;
    }
  }
  return dots;
}

/** ^GFA: rows of bits padded to whole bytes, in hex, with a set bit printing. */
export function graphicField(dots: readonly boolean[], width: number, height: number): string {
  const rowBytes = Math.ceil(width / 8);
  const bytes = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dots[y * width + x]) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const hex = Buffer.from(bytes).toString("hex").toUpperCase();
  return `^GFA,${bytes.length},${bytes.length},${rowBytes},${hex}`;
}

/** The file a picture's address names, or null if it isn't one Holt holds. */
export function localPicturePath(imageUrl: string): string | null {
  if (!imageUrl.startsWith("/uploads/")) return null;
  const resolved = path.resolve(UPLOAD_ROOT, `.${imageUrl.slice("/uploads".length)}`);
  return resolved.startsWith(`${UPLOAD_ROOT}${path.sep}`) ? resolved : null;
}

/** The picture as a graphic field; empty when there's nothing to print. */
export async function photoField(
  imageUrl: string | null | undefined,
  photoDots: number | null | undefined,
): Promise<ZplGraphic | string> {
  if (!imageUrl || !photoDots) return "";
  const file = localPicturePath(imageUrl);
  if (!file) return "";
  try {
    const { data, info } = await sharp(file)
      .flatten({ background: "#ffffff" })
      .resize(photoDots, photoDots, { fit: "inside", withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const dots = ditherToDots(new Uint8Array(data), info.width, info.height);
    return new ZplGraphic(graphicField(dots, info.width, info.height));
  } catch (err) {
    logger.warn("A product picture could not be put on a tag", {
      imageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

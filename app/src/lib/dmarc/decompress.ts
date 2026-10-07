// /app/src/lib/dmarc/decompress.ts
// Client-side decompression for DMARC report files: raw .xml, gzip (.gz), or a
// single-entry .zip. Uses only web-standard APIs (DecompressionStream,
// TextDecoderStream, Blob, streams) — which also exist in modern Node, so this
// module is verifiable outside the browser. Nothing is uploaded; the report is
// decompressed and read entirely on the client.
//
// Security posture (see the threat model behind this feature):
//  - Format is decided by MAGIC BYTES, never the filename/extension.
//  - Hard input-size cap before any work; a streaming byte-counter aborts
//    decompression the instant output exceeds a cap (decompression-bomb guard).
//  - Exactly ONE level of decompression — a decompressed result that is itself
//    an archive is rejected (no recursion / zip-quine).
//  - Zip parsing reads sizes/method from the central directory (authoritative),
//    bounds-checks every offset, caps entry count, and rejects Zip64/encrypted/
//    unsupported methods rather than guessing.

// Real DMARC reports are KB to low-MB. These bound worst case generously.
export const MAX_INPUT_BYTES = 5 * 1024 * 1024; // reject input files over 5 MB
export const MAX_DECOMPRESSED_BYTES = 30 * 1024 * 1024; // abort output over 30 MB
const MAX_ZIP_ENTRIES = 16;

export class DmarcDecompressError extends Error {}

type Format = "gzip" | "zip" | "xml" | "empty-zip" | "unsupported";

function sniff(bytes: Uint8Array): Format {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
    if (bytes[2] === 0x05 && bytes[3] === 0x06) return "empty-zip";
    return "unsupported"; // spanned (PK\x07\x08) etc.
  }
  return "xml";
}

// Counting TransformStream: aborts the moment cumulative output exceeds max.
// Inserted BEFORE text decoding so the cap is on raw decompressed bytes.
function byteCapStream(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) {
        controller.error(
          new DmarcDecompressError(
            "File expands too large — refused as a possible decompression bomb.",
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  // Read the byte-capped stream fully (bounded by MAX_DECOMPRESSED_BYTES), then
  // decode once. Avoids TextDecoderStream's DOM-lib typing friction and lets us
  // strip a leading BOM explicitly.
  const reader = stream.pipeThrough(byteCapStream(MAX_DECOMPRESSED_BYTES)).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  let text = new TextDecoder("utf-8").decode(merged);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

async function inflate(bytes: Uint8Array, format: "gzip" | "deflate-raw"): Promise<string> {
  const ds = new DecompressionStream(format);
  // Copy into a fresh ArrayBuffer-backed view so Blob gets clean bytes.
  const blob = new Blob([bytes.slice()]);
  try {
    return await streamToText(blob.stream().pipeThrough(ds));
  } catch (e) {
    if (e instanceof DmarcDecompressError) throw e;
    throw new DmarcDecompressError(
      "Couldn't decompress that file — it may be corrupt or incomplete.",
    );
  }
}

// ── Minimal single-entry zip reader ─────────────────────────────────────────
// Reads the central directory (authoritative for method/sizes even when the
// streaming bit is set), locates the one .xml entry, and returns the raw
// compressed bytes + method. Native DecompressionStream does the inflate.

const u16 = (dv: DataView, o: number) => dv.getUint16(o, true);
const u32 = (dv: DataView, o: number) => dv.getUint32(o, true);

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

interface ZipEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  name: string;
}

function readZipCentralDirectory(buf: ArrayBuffer): ZipEntry {
  const dv = new DataView(buf);
  const len = buf.byteLength;
  if (len < 22) throw new DmarcDecompressError("That zip file is incomplete.");

  // EOCD is in the last (22 + comment<=65535) bytes; scan backward for its sig.
  const scanStart = Math.max(0, len - (22 + 65535));
  let eocd = -1;
  for (let i = len - 22; i >= scanStart; i--) {
    if (u32(dv, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DmarcDecompressError("That doesn't look like a valid zip file.");

  const totalEntries = u16(dv, eocd + 10);
  const cdOffset = u32(dv, eocd + 16);
  if (totalEntries === 0) throw new DmarcDecompressError("That zip archive is empty.");
  if (totalEntries > MAX_ZIP_ENTRIES)
    throw new DmarcDecompressError(
      "That zip has too many files — upload the .xml report directly.",
    );
  if (cdOffset === ZIP64_SENTINEL)
    throw new DmarcDecompressError(
      "Zip64 archives aren't supported — upload the .xml report directly.",
    );

  let ptr = cdOffset;
  let chosen: ZipEntry | undefined;
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > len || u32(dv, ptr) !== SIG_CEN) {
      throw new DmarcDecompressError("That zip archive is malformed.");
    }
    const method = u16(dv, ptr + 10);
    const compressedSize = u32(dv, ptr + 20);
    const uncompressedSize = u32(dv, ptr + 24);
    const nameLen = u16(dv, ptr + 28);
    const extraLen = u16(dv, ptr + 30);
    const commentLen = u16(dv, ptr + 32);
    const localOffset = u32(dv, ptr + 42);
    const nameStart = ptr + 46;
    if (nameStart + nameLen > len) throw new DmarcDecompressError("That zip archive is malformed.");
    const name = new TextDecoder("utf-8").decode(new Uint8Array(buf, nameStart, nameLen));

    const isDir = name.endsWith("/");
    if (
      !isDir &&
      name.toLowerCase().endsWith(".xml") &&
      compressedSize !== ZIP64_SENTINEL &&
      uncompressedSize !== ZIP64_SENTINEL
    ) {
      if (uncompressedSize > MAX_DECOMPRESSED_BYTES) {
        throw new DmarcDecompressError("That report is too large to process safely.");
      }
      if (!chosen) chosen = { method, compressedSize, uncompressedSize, localOffset, name };
    }
    ptr = nameStart + nameLen + extraLen + commentLen;
  }

  if (!chosen)
    throw new DmarcDecompressError(
      "No .xml report found inside that zip — upload the .xml directly.",
    );
  return chosen;
}

async function decompressZip(buf: ArrayBuffer): Promise<string> {
  const entry = readZipCentralDirectory(buf);
  const dv = new DataView(buf);
  const len = buf.byteLength;

  // The local header tells us where the data actually starts (its name/extra
  // lengths can differ from the central directory's).
  if (entry.localOffset + 30 > len || u32(dv, entry.localOffset) !== SIG_LOCAL) {
    throw new DmarcDecompressError("That zip archive is malformed.");
  }
  const localNameLen = u16(dv, entry.localOffset + 26);
  const localExtraLen = u16(dv, entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen;

  if (entry.method === 0) {
    // Stored: bytes are the XML verbatim.
    const end = dataStart + entry.uncompressedSize;
    if (end > len) throw new DmarcDecompressError("That zip archive is truncated.");
    const text = new TextDecoder("utf-8").decode(
      new Uint8Array(buf, dataStart, entry.uncompressedSize),
    );
    if (entry.uncompressedSize > MAX_DECOMPRESSED_BYTES) {
      throw new DmarcDecompressError("That report is too large to process safely.");
    }
    return text;
  }
  if (entry.method === 8) {
    // Deflate: hand the raw compressed bytes to the native codec.
    const end = dataStart + entry.compressedSize;
    if (end > len) throw new DmarcDecompressError("That zip archive is truncated.");
    return inflate(new Uint8Array(buf, dataStart, entry.compressedSize), "deflate-raw");
  }
  throw new DmarcDecompressError(
    "That zip uses an unsupported compression method — upload the .xml directly.",
  );
}

function looksLikeXml(text: string): boolean {
  const head = text.slice(0, 256).replace(/^﻿/, "").trimStart();
  return head.startsWith("<");
}

/**
 * Decompress (if needed) raw file bytes into a DMARC report XML string.
 * Accepts ArrayBuffer or Uint8Array so it runs in the browser and in tests.
 * Throws DmarcDecompressError with a user-facing message on any problem.
 */
export async function decompressToXml(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new DmarcDecompressError("That file is empty.");
  if (bytes.length > MAX_INPUT_BYTES)
    throw new DmarcDecompressError(
      "That file is too large — DMARC reports are small. Check you uploaded the right file.",
    );

  const format = sniff(bytes);
  let xml: string;
  switch (format) {
    case "xml":
      xml = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
      break;
    case "gzip":
      xml = await inflate(bytes, "gzip");
      break;
    case "zip": {
      // Zip needs random access; copy into a standalone ArrayBuffer.
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      try {
        xml = await decompressZip(ab);
      } catch (e) {
        // Surface our own clean errors; convert any unexpected error (e.g. a
        // DataView RangeError from a crafted archive) into a friendly message.
        if (e instanceof DmarcDecompressError) throw e;
        throw new DmarcDecompressError(
          "That zip archive is malformed or unsupported — extract it and upload the .xml.",
        );
      }
      break;
    }
    case "empty-zip":
      throw new DmarcDecompressError("That zip archive is empty.");
    default:
      throw new DmarcDecompressError(
        "Unsupported file type. Upload a .xml, .xml.gz, or .zip DMARC report, or paste the XML.",
      );
  }

  // Exactly one level of decompression: a decompressed payload that is itself
  // an archive (gzip or zip magic) is an attack shape, not a real report.
  if (
    (xml.length >= 2 && xml.charCodeAt(0) === 0x1f && xml.charCodeAt(1) === 0x8b) ||
    (xml.length >= 2 && xml.charCodeAt(0) === 0x50 && xml.charCodeAt(1) === 0x4b)
  ) {
    throw new DmarcDecompressError(
      "That file is doubly compressed — extract it and upload the .xml.",
    );
  }
  if (!looksLikeXml(xml)) {
    throw new DmarcDecompressError(
      "That file didn't contain XML. Upload a DMARC report or paste its XML.",
    );
  }
  return xml;
}

/** Thin File wrapper for the browser. */
export async function decompressFile(file: File): Promise<string> {
  if (file.size > MAX_INPUT_BYTES) {
    throw new DmarcDecompressError(
      "That file is too large — DMARC reports are small. Check you uploaded the right file.",
    );
  }
  return decompressToXml(await file.arrayBuffer());
}

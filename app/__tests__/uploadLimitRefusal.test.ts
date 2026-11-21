// /app/__tests__/uploadLimitRefusal.test.ts
//
// An upload that its preset's limits refuse is the caller's to fix, so the
// route answers 413 and says the limit. The parser behind createSecureForm
// (formidable, lib/secureUpload.ts) refuses a file past the size limit, and a
// second file where the preset takes one, by failing parse(); the routes'
// catch turned that into "Parse failed" or "Import failed", a 500.
// uploadLimitRefusal is the one place that maps it (rule 42).
//
// A file of a type the preset does not take fails nothing: the filter drops it
// and the route finds no file. Three routes answered that, and a form with no
// file at all, with a 500 too; it is a 400 now, as their sibling routes already
// answered.
//
// The routes are driven with real multipart bodies through the real
// createSecureForm and formidable. The size cases shrink the presets' limits
// to 1 MB and 2 MB first, so a case streams a couple of megabytes rather than
// 30 or 50; the real limits' wording is pinned on the function itself.
//
// A second file is refused through the routes' same catch, so it is checked
// once, on a real parse, rather than per route: formidable opens and writes the
// file it refused after its own cleanup has run and never removes it, and only
// a test holding the form can wait for that file and remove it.

import type { NextApiRequest, NextApiResponse } from "next";
import type { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { errors as formidableErrors } from "formidable";
import {
  createSecureForm,
  UPLOAD_PRESETS,
  uploadLimitRefusal,
  type UploadPresetName,
} from "@/lib/secureUpload";
import importSheetRoute from "@/pages/api/admin/service/import-sheet";
import apparelPreviewRoute from "@/pages/api/tools/apparel-order/preview";
import homeAccessoryPreviewRoute from "@/pages/api/tools/home-accessory-order/preview";
import previewZSupplyRoute from "@/pages/api/purchasing/preview-zsupply";
import importZSupplyRoute from "@/pages/api/purchasing/import-zsupply";
import previewNuOrderRoute from "@/pages/api/purchasing/preview-nuorder";
import importNuOrderRoute from "@/pages/api/purchasing/import-nuorder";

jest.mock("@/lib/auth/requireAuth", () => ({
  // Bypass auth; the gates are covered by the apiRouteAuthorization tripwire.
  requirePermission:
    (_permission: unknown, handler: (...a: unknown[]) => unknown) => (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "admin@example.com" } }, { holds: {} }),
}));

const FormidableError = formidableErrors.default;
const MB = 1024 * 1024;

describe("uploadLimitRefusal", () => {
  const refusedBy = (code: number) => new FormidableError("formidable's own words", code, 413);
  const TOO_LARGE = [
    formidableErrors.biggerThanTotalMaxFileSize,
    formidableErrors.biggerThanMaxFileSize,
  ];

  it.each([
    ["PDF", "The upload is larger than the 30 MB limit."],
    ["CSV_XLSX", "The upload is larger than the 50 MB limit."],
    ["IMAGE", "The upload is larger than the 10 MB limit."],
  ] as const)("says the %s preset's size limit for an upload over it", (preset, error) => {
    for (const code of TOO_LARGE) {
      expect(uploadLimitRefusal(refusedBy(code), preset)).toEqual({ status: 413, error });
    }
  });

  it("says how many files the preset takes for one too many", () => {
    const tooMany = refusedBy(formidableErrors.maxFilesExceeded);
    expect(uploadLimitRefusal(tooMany, "PDF")).toEqual({
      status: 413,
      error: "Upload one file at a time.",
    });
    expect(uploadLimitRefusal(tooMany, "DELIVERY_PROOF")).toEqual({
      status: 413,
      error: "Upload at most 2 files at a time.",
    });
  });

  it("leaves every other error to the route", () => {
    expect(uploadLimitRefusal(new Error("ENOSPC: no space left on device"), "PDF")).toBeNull();
    const malformed = new FormidableError("bad body", formidableErrors.malformedMultipart, 400);
    expect(uploadLimitRefusal(malformed, "PDF")).toBeNull();
    expect(uploadLimitRefusal("a thrown string", "PDF")).toBeNull();
    expect(uploadLimitRefusal(undefined, "PDF")).toBeNull();
  });

  it("maps formidable's own refusal of a second file, from a real parse", async () => {
    const form = createSecureForm("PDF");
    let refusedPath: string | undefined;
    // Settles when formidable has finished writing the file it refused, or
    // after a second if a later formidable stops writing it.
    const refusedFileWritten = new Promise<void>((resolve) => {
      setTimeout(resolve, 1000).unref();
      let begun = 0;
      form.on("fileBegin", (_name, file) => {
        begun += 1;
        if (begun !== 2) return;
        refusedPath = file.filepath;
        // Typed as the File shape; at run time it is formidable's PersistentFile.
        (file as unknown as EventEmitter).on("end", () => resolve());
      });
    });
    const err = await form
      .parse(
        multipart([
          { ...PDF, body: Buffer.from("the first") },
          { ...PDF, body: Buffer.from("the second") },
        ]),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    await refusedFileWritten;
    if (refusedPath) rmSync(refusedPath, { force: true });
    expect(uploadLimitRefusal(err, "PDF")).toEqual({
      status: 413,
      error: "Upload one file at a time.",
    });
  });
});

// ── The routes, through real multipart bodies ──────────────────────────────

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

interface Part {
  name: string;
  filename?: string;
  type?: string;
  body: Buffer;
}

/** A multipart POST carrying `parts`, as the browser sends one. */
function multipart(parts: Part[], query: Record<string, string> = {}): NextApiRequest {
  const boundary = "holt-upload-test-boundary";
  const pieces: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}`
      : `form-data; name="${part.name}"`;
    pieces.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n`),
      part.body,
      Buffer.from("\r\n"),
    );
  }
  pieces.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(pieces);
  return Object.assign(Readable.from([body]), {
    method: "POST",
    query,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
  }) as unknown as NextApiRequest;
}

async function send(route: Route, parts: Part[], query?: Record<string, string>) {
  const res = {
    status: 0,
    body: undefined as unknown,
  };
  const recorder = {
    status(code: number) {
      res.status = code;
      return this;
    },
    json(value: unknown) {
      res.body = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(multipart(parts, query), recorder as unknown as NextApiResponse);
  return res;
}

const PDF = { name: "file", filename: "order.pdf", type: "application/pdf" };
const SHEET = {
  name: "file",
  filename: "cases.xlsx",
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const CSV = { name: "file", filename: "order.csv", type: "text/csv" };

/** Two limits that differ, so a route that names the wrong preset says the wrong one. */
const SHRUNK: Record<"PDF" | "CSV_XLSX", number> = { PDF: 1 * MB, CSV_XLSX: 2 * MB };

const ROUTES: {
  name: string;
  route: Route;
  preset: "PDF" | "CSV_XLSX";
  file: Omit<Part, "body">;
  query?: Record<string, string>;
}[] = [
  { name: "admin/service/import-sheet", route: importSheetRoute, preset: "CSV_XLSX", file: SHEET },
  { name: "tools/apparel-order/preview", route: apparelPreviewRoute, preset: "PDF", file: PDF },
  {
    name: "tools/home-accessory-order/preview, a PDF format",
    route: homeAccessoryPreviewRoute,
    preset: "PDF",
    file: PDF,
    query: { format: "kk-interiors" },
  },
  {
    name: "tools/home-accessory-order/preview, a CSV format",
    route: homeAccessoryPreviewRoute,
    preset: "CSV_XLSX",
    file: CSV,
    query: { format: "maison-zoe-ford" },
  },
  { name: "purchasing/preview-zsupply", route: previewZSupplyRoute, preset: "PDF", file: PDF },
  { name: "purchasing/import-zsupply", route: importZSupplyRoute, preset: "PDF", file: PDF },
  { name: "purchasing/preview-nuorder", route: previewNuOrderRoute, preset: "PDF", file: PDF },
  { name: "purchasing/import-nuorder", route: importNuOrderRoute, preset: "PDF", file: PDF },
];

describe("upload routes refuse an upload past their preset's limits with a 413", () => {
  const real = {
    PDF: UPLOAD_PRESETS.PDF.maxFileSize,
    CSV_XLSX: UPLOAD_PRESETS.CSV_XLSX.maxFileSize,
  };
  beforeAll(() => {
    UPLOAD_PRESETS.PDF.maxFileSize = SHRUNK.PDF;
    UPLOAD_PRESETS.CSV_XLSX.maxFileSize = SHRUNK.CSV_XLSX;
  });
  afterAll(() => {
    UPLOAD_PRESETS.PDF.maxFileSize = real.PDF;
    UPLOAD_PRESETS.CSV_XLSX.maxFileSize = real.CSV_XLSX;
  });

  it.each(ROUTES)(
    "$name answers a file over the size limit with 413 and the limit",
    async ({ route, preset, file, query }) => {
      const over = Buffer.alloc(SHRUNK[preset] + 1, 0x25);
      const res = await send(route, [{ ...file, body: over }], query);
      expect(res).toEqual({
        status: 413,
        body: { error: `The upload is larger than the ${SHRUNK[preset] / MB} MB limit.` },
      });
    },
  );
});

const PARSED_BEFORE_THE_FILE_CHECK: { name: string; route: Route; refused: Omit<Part, "body"> }[] =
  [
    {
      name: "admin/service/import-sheet",
      route: importSheetRoute,
      refused: { name: "file", filename: "cases.txt", type: "text/plain" },
    },
    {
      name: "purchasing/import-zsupply",
      route: importZSupplyRoute,
      refused: { name: "file", filename: "invoice.txt", type: "text/plain" },
    },
    {
      name: "purchasing/import-nuorder",
      route: importNuOrderRoute,
      refused: { name: "file", filename: "order.txt", type: "text/plain" },
    },
  ];

describe.each(PARSED_BEFORE_THE_FILE_CHECK)("$name with no file", ({ route, refused }) => {
  it("answers a form without a file with 400", async () => {
    const res = await send(route, [{ name: "dryRun", body: Buffer.from("true") }]);
    expect(res).toEqual({ status: 400, body: { error: "No file uploaded" } });
  });

  it("answers a file of a type it does not take the same way: the filter drops it", async () => {
    const res = await send(route, [{ ...refused, body: Buffer.from("not a spreadsheet") }]);
    expect(res).toEqual({ status: 400, body: { error: "No file uploaded" } });
  });
});

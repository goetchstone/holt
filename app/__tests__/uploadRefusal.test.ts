// /app/__tests__/uploadRefusal.test.ts
//
// An upload the parser refuses is the caller's to fix, so the route answers a
// 4xx that says what to fix. The parser behind createSecureForm (formidable,
// lib/secureUpload.ts) refuses a file past the size limit, a second file where
// the preset takes one, an empty file, and a body it can't read as a form (one
// cut off on its way), by failing parse() with a 4xx-coded error; the routes'
// catch turned each into "Parse failed" or "Import failed", a 500 logged as a
// fault. uploadRefusal is the one place that maps them (rule 42).
//
// A file of a type the preset does not take fails nothing: the filter drops it
// and the route finds no file. Every route answers that, and a form with no
// file at all, with a 400 naming the types it takes (noFileMessage).
//
// The routes are driven with real multipart bodies through the real
// createSecureForm and formidable. The size cases shrink the presets' limits
// to 1 MB and 2 MB first, so a case streams a couple of megabytes rather than
// 30 or 50; the real limits' wording is pinned on the function itself.
//
// formidable leaves some files it refused on disk: an empty file, and a second
// file, which it opens after its own cleanup has run. So every form the routes
// make here is watched, and the files it opened are removed after each test.
//
// A second file is refused through the routes' same catch, so it is checked
// once, on a real parse, rather than per route; only a test holding the form
// can wait for that file to be written and remove it.

import type { NextApiRequest, NextApiResponse } from "next";
import type { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { errors as formidableErrors, type File } from "formidable";
import {
  createSecureForm,
  UPLOAD_PRESETS,
  uploadRefusal,
  type UploadPresetName,
} from "@/lib/secureUpload";

/** Every file a form opened during the test now running. */
const opened: string[] = [];
jest.mock("@/lib/secureUpload", () => {
  const actual = jest.requireActual("@/lib/secureUpload");
  return {
    ...actual,
    createSecureForm: (...args: Parameters<typeof actual.createSecureForm>) => {
      const form = actual.createSecureForm(...args);
      form.on("fileBegin", (_name: string, file: File) => opened.push(file.filepath));
      return form;
    },
  };
});
afterEach(async () => {
  if (opened.length === 0) return;
  // formidable opens a file asynchronously; give the open time to land first.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const path of opened.splice(0)) rmSync(path, { force: true });
});
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
const UNREADABLE = "The upload couldn't be read. Send the file again.";
const TOO_MANY_FIELDS = "The upload's form has more fields than an upload takes.";

describe("uploadRefusal", () => {
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
      expect(uploadRefusal(refusedBy(code), preset)).toEqual({ status: 413, error });
    }
  });

  it("says how many files the preset takes for one too many", () => {
    const tooMany = refusedBy(formidableErrors.maxFilesExceeded);
    expect(uploadRefusal(tooMany, "PDF")).toEqual({
      status: 413,
      error: "Upload one file at a time.",
    });
    expect(uploadRefusal(tooMany, "DELIVERY_PROOF")).toEqual({
      status: 413,
      error: "Upload at most 2 files at a time.",
    });
  });

  // formidable 3.5.4 raises each of these on the caller's upload, with that
  // httpCode (src/Formidable.js, src/parsers/Multipart.js, src/plugins/multipart.js).
  it.each([
    ["an empty file", formidableErrors.noEmptyFiles, 400, 400, "The file is empty."],
    [
      "a file under minFileSize",
      formidableErrors.smallerThanMinFileSize,
      400,
      400,
      "The file is empty.",
    ],
    ["a malformed multipart body", formidableErrors.malformedMultipart, 400, 400, UNREADABLE],
    [
      "a multipart body with no boundary",
      formidableErrors.missingMultipartBoundary,
      400,
      400,
      UNREADABLE,
    ],
    ["no content type", formidableErrors.missingContentType, 400, 400, UNREADABLE],
    ["a body that isn't a form", formidableErrors.noParser, 415, 415, UNREADABLE],
    ["too many form fields", formidableErrors.maxFieldsExceeded, 413, 413, TOO_MANY_FIELDS],
    ["form fields too long", formidableErrors.maxFieldsSizeExceeded, 413, 413, TOO_MANY_FIELDS],
  ])("answers %s with a %p in plain words", (_what, code, httpCode, status, error) => {
    const refused = new FormidableError("options.formidable (8 bytes) inferior", code, httpCode);
    expect(uploadRefusal(refused, "PDF")).toEqual({ status, error });
  });

  it("answers a refusal formidable adds later, coded below 500, with a 4xx too", () => {
    const later = new FormidableError("options.somethingNew exceeded", 1099, 422);
    expect(uploadRefusal(later, "PDF")).toEqual({ status: 422, error: UNREADABLE });
  });

  it("leaves every other error to the route, its own 500", () => {
    expect(uploadRefusal(new Error("ENOSPC: no space left on device"), "PDF")).toBeNull();
    // formidable codes it 409, but the directory is the server's, not the caller's upload.
    const noDir = new FormidableError(
      "cannot create directory",
      formidableErrors.cannotCreateDir,
      409,
    );
    expect(uploadRefusal(noDir, "PDF")).toBeNull();
    const aborted = new FormidableError("Request aborted", formidableErrors.aborted, 500);
    expect(uploadRefusal(aborted, "PDF")).toBeNull();
    const encoding = new FormidableError("unknown", formidableErrors.unknownTransferEncoding, 501);
    expect(uploadRefusal(encoding, "PDF")).toBeNull();
    expect(uploadRefusal("a thrown string", "PDF")).toBeNull();
    expect(uploadRefusal(undefined, "PDF")).toBeNull();
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
    expect(uploadRefusal(err, "PDF")).toEqual({
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

/**
 * A multipart POST carrying `parts`, as the browser sends one; `cutOff` ends it
 * inside the last part, as an upload interrupted on its way does.
 */
function multipart(
  parts: Part[],
  query: Record<string, string> = {},
  cutOff = false,
): NextApiRequest {
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
  if (cutOff) pieces.pop();
  else pieces.push(Buffer.from(`--${boundary}--\r\n`));
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

async function send(route: Route, parts: Part[], query?: Record<string, string>, cutOff = false) {
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
  await route(multipart(parts, query, cutOff), recorder as unknown as NextApiResponse);
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
  /** Form fields the route reads before it looks for the file. */
  fields?: Part[];
}[] = [
  { name: "admin/service/import-sheet", route: importSheetRoute, preset: "CSV_XLSX", file: SHEET },
  {
    name: "tools/apparel-order/preview",
    route: apparelPreviewRoute,
    preset: "PDF",
    file: PDF,
    fields: [{ name: "format", body: Buffer.from("rails") }],
  },
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

// The parser refuses these by failing parse(), with a 4xx code; the routes'
// catch answered them with its fixed 500 ("Parse failed", "Import failed").
describe("upload routes answer an upload the parser refuses with a 4xx in plain words", () => {
  it.each(ROUTES)("$name answers an empty file with 400", async ({ route, file, query }) => {
    const res = await send(route, [{ ...file, body: Buffer.alloc(0) }], query);
    expect(res).toEqual({ status: 400, body: { error: "The file is empty." } });
  });

  it.each(ROUTES)(
    "$name answers an upload cut off on its way with 400",
    async ({ route, file, query }) => {
      const res = await send(route, [{ ...file, body: Buffer.from("%PDF-1.7 half") }], query, true);
      expect(res).toEqual({ status: 400, body: { error: UNREADABLE } });
    },
  );
});

/** What a route says when the form carries no file its preset takes. */
const TAKES = {
  PDF: "Upload a .pdf file.",
  CSV_XLSX: "Upload a .csv, .xlsx or .xls file.",
};

describe.each(ROUTES)("$name with no file it takes", ({ route, preset, query, fields = [] }) => {
  it("answers a form without a file with 400 and the types it takes", async () => {
    const res = await send(
      route,
      [...fields, { name: "dryRun", body: Buffer.from("true") }],
      query,
    );
    expect(res).toEqual({ status: 400, body: { error: TAKES[preset] } });
  });

  it("answers a file of a type it does not take the same way: the filter drops it", async () => {
    const notes = {
      name: "file",
      filename: "notes.txt",
      type: "text/plain",
      body: Buffer.from("x"),
    };
    const res = await send(route, [...fields, notes], query);
    expect(res).toEqual({ status: 400, body: { error: TAKES[preset] } });
  });
});

// /app/__tests__/orderUploadNoLines.test.ts
//
// A parse can leave every line out: a Simblist row whose cell does not read, a
// Z Supply style whose pack count overflows, a nuORDER item past the line cut.
// Its warnings are then the only account of why, so every order-upload route
// that answers "No line items found" sends them with the 400 (2026-11-21); the
// pages list them. The parsers and normalizers run for real on the uploaded
// text. Stood in for: the session gate, the multipart form and pdf-parse's text
// extraction. Prisma is not mocked: these routes query it only after the check
// this test stops at, and the unit project gives it no database URL.

jest.mock("@/lib/auth/requireAuth", () => ({
  requirePermission: (_key: string, h: unknown) => h,
}));
jest.mock("@/lib/logger", () => ({ logError: jest.fn(), logger: { info: jest.fn() } }));
jest.mock("@/lib/pricing/pdfUtils", () => ({ parsePdf: jest.fn() }));
jest.mock("@/lib/secureUpload", () => ({ createSecureForm: jest.fn() }));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { parsePdf } from "@/lib/pricing/pdfUtils";
import { createSecureForm } from "@/lib/secureUpload";
import homeAccessoryPreview from "@/pages/api/tools/home-accessory-order/preview";
import apparelPreview from "@/pages/api/tools/apparel-order/preview";
import previewNuOrder from "@/pages/api/purchasing/preview-nuorder";
import importNuOrder from "@/pages/api/purchasing/import-nuorder";
import importZSupply from "@/pages/api/purchasing/import-zsupply";

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => unknown;

const session = { user: { email: "buyer@store.test" } } as unknown as Session;

/** The only nuORDER item is past the 1000-character cut, so none is read. */
const NUORDER_CUT = `${"x".repeat(1000)}Style #: ET100BLK\n$38.50 3 $115.50`;
/** A pack count that reads but overflows once multiplied out to sizes. */
const ZSUPPLY_OVERFLOW = [
  "ZT100001BLKEasy Rib Tank Black",
  "A    B    C    D    E    F   XS    S    M    L   XL",
  `${"9".repeat(308)}  48.00     48.00`,
].join("\n");
/** One Simblist row, whose Quantity is not a whole number. */
const SIMBLIST_UNREAD = [
  "RepGroup,Manufacturer,PO #,Order Total",
  "Simblist,X Co,PON1,",
  "Item Number,Name,Quantity,Unit Price,UPC,Total Price",
  "A1,Mix,2.5,36.00,123,$90.00",
].join("\n");

let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "order-upload-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The multipart form hands the route `fields` and one file holding `content`. */
function upload(fields: Record<string, string[]>, content: string) {
  const filepath = path.join(dir, "upload");
  fs.writeFileSync(filepath, content);
  const files = { file: [{ filepath }] };
  (createSecureForm as jest.Mock).mockReturnValue({
    // Promise style (the preview routes) and callback style (the import routes).
    parse: (_req: unknown, done?: (err: unknown, f: unknown, files: unknown) => void) => {
      if (done) return done(null, fields, files);
      return Promise.resolve([fields, files]);
    },
  });
}

async function post(handler: Handler, query: Record<string, string> = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    setHeader() {},
  };
  const req = { method: "POST", query, headers: {} } as unknown as NextApiRequest;
  await handler(req, res as unknown as NextApiResponse, session);
  return res;
}

describe("an order upload whose every line was left out", () => {
  it.each([
    [
      "tools/home-accessory-order/preview (Simblist CSV)",
      homeAccessoryPreview as Handler,
      { format: "maison-zoe-ford" },
      {},
      SIMBLIST_UNREAD,
      "No line items found in the uploaded file",
      /^Item A1: the Quantity "2\.5" is not a whole number/,
    ],
    [
      "tools/apparel-order/preview (nuORDER)",
      apparelPreview as Handler,
      {},
      { format: ["nuorder"] },
      NUORDER_CUT,
      "No line items found in PDF",
      /^1 line is longer than 1000 characters/,
    ],
    [
      "tools/apparel-order/preview (Z Supply)",
      apparelPreview as Handler,
      {},
      { format: ["zsupply"] },
      ZSUPPLY_OVERFLOW,
      "No line items found in PDF",
      /^Style ZT100001 \(BLK\): the pack count or price is too large/,
    ],
    [
      "purchasing/preview-nuorder",
      previewNuOrder as Handler,
      {},
      {},
      NUORDER_CUT,
      "No line items found in PDF",
      /^1 line is longer than 1000 characters/,
    ],
    [
      "purchasing/import-nuorder",
      importNuOrder as Handler,
      {},
      {},
      NUORDER_CUT,
      "No line items found in PDF",
      /^1 line is longer than 1000 characters/,
    ],
    [
      "purchasing/import-zsupply",
      importZSupply as Handler,
      {},
      {},
      ZSUPPLY_OVERFLOW,
      "No line items found in PDF",
      /^Style ZT100001 \(BLK\): the pack count or price is too large/,
    ],
  ])(
    "%s answers 400 with the warnings that say why",
    async (_route, handler, query, fields, text, error, warning) => {
      upload(fields, text);
      (parsePdf as jest.Mock).mockResolvedValue({ text });
      const res = await post(handler, query);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error,
        warnings: expect.arrayContaining([expect.stringMatching(warning)]),
      });
    },
  );
});

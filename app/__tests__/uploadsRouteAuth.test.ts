// /app/__tests__/uploadsRouteAuth.test.ts
//
// SEC-04: the uploads route used to serve the ENTIRE upload root to anyone,
// protected only by a 48-bit random filename -- customer imports, vendor price
// PDFs, delivery-proof signatures. It now gates every subdir that is not
// explicitly public (product imagery + portal attachments), answers an
// unauthenticated request for a private file with 404 (never confirming the
// file exists), and forces SVGs to download instead of executing inline.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { Writable } from "stream";
import fs from "fs";
import path from "path";
import { getServerSession } from "next-auth";

import handler, { isPublicUpload } from "@/pages/api/uploads/[...path]";

const sessionMock = getServerSession as jest.Mock;
const ROOT = path.join(process.cwd(), "data", "uploads");

const FILES = {
  csv: ["imports", "test-sec04.csv"],
  png: ["images", "test-sec04.png"],
  svg: ["images", "test-sec04.svg"],
};

const abs = (segments: string[]) => path.join(ROOT, ...segments);

function makeReq(segments: string[]): NextApiRequest {
  return { method: "GET", query: { path: segments } } as unknown as NextApiRequest;
}

type TestRes = NextApiResponse & {
  _headers: Record<string, unknown>;
  _status: number;
  _body?: unknown;
  done: Promise<void>;
};

function makeRes(): TestRes {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const res = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as TestRes;
  res.on("finish", () => resolveDone());
  res.on("close", () => resolveDone());
  res._headers = {};
  res._status = 0;
  res.done = done;
  res.setHeader = ((k: string, v: unknown) => {
    res._headers[k] = v;
    return res;
  }) as unknown as TestRes["setHeader"];
  (res as unknown as { status: (c: number) => TestRes }).status = (c: number) => {
    res._status = c;
    return res;
  };
  (res as unknown as { json: (p: unknown) => TestRes }).json = (p: unknown) => {
    res._body = p;
    res.end();
    return res;
  };
  return res;
}

beforeAll(() => {
  for (const seg of Object.values(FILES)) {
    fs.mkdirSync(abs(seg.slice(0, -1)), { recursive: true });
    fs.writeFileSync(abs(seg), "x");
  }
});

afterAll(() => {
  for (const seg of Object.values(FILES)) {
    try {
      fs.unlinkSync(abs(seg));
    } catch {
      /* ignore */
    }
  }
});

describe("isPublicUpload", () => {
  it("classifies product imagery + attachments public, everything else private", () => {
    expect(isPublicUpload(["images", "a.jpg"])).toBe(true);
    expect(isPublicUpload(["inventory", "a.jpg"])).toBe(true);
    expect(isPublicUpload(["line-drawings", "a.png"])).toBe(true);
    expect(isPublicUpload(["attachments", "a.pdf"])).toBe(true);
    expect(isPublicUpload(["imports", "customers.csv"])).toBe(false);
    expect(isPublicUpload(["pdfs", "book.pdf"])).toBe(false);
    expect(isPublicUpload(["delivery-proof", "sig.png"])).toBe(false);
    expect(isPublicUpload(["proposals", "p.pdf"])).toBe(false);
    // Default private: a subdir nobody opted in is gated.
    expect(isPublicUpload(["something-new", "x"])).toBe(false);
    expect(isPublicUpload([])).toBe(false);
  });
});

describe("uploads route access control", () => {
  it("a private import file is 404 without a session, and served with one", async () => {
    sessionMock.mockResolvedValueOnce(null);
    const anon = makeRes();
    await handler(makeReq(FILES.csv), anon);
    await anon.done;
    expect(anon._status).toBe(404);
    expect(anon._headers["Content-Type"]).toBeUndefined();

    sessionMock.mockResolvedValueOnce({ user: { email: "staff@store.com" } });
    const authed = makeRes();
    await handler(makeReq(FILES.csv), authed);
    await authed.done;
    // Reached serving (private, non-cacheable, downloaded as octet-stream).
    expect(authed._headers["Content-Type"]).toBe("application/octet-stream");
    expect(authed._headers["Cache-Control"]).toBe("private, no-store, max-age=0");
    expect(authed._status).not.toBe(404);
  });

  it("a public product image is served without a session", async () => {
    const res = makeRes();
    await handler(makeReq(FILES.png), res);
    await res.done;
    expect(res._headers["Content-Type"]).toBe("image/png");
    expect(res._headers["Cache-Control"]).toBe("public, max-age=86400, immutable");
  });

  it("an SVG is forced to download instead of rendering inline", async () => {
    const res = makeRes();
    await handler(makeReq(FILES.svg), res);
    await res.done;
    expect(res._headers["Content-Type"]).toBe("application/octet-stream");
    expect(res._headers["Content-Disposition"]).toBe("attachment");
  });
});

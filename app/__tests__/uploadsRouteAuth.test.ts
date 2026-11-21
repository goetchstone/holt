// /app/__tests__/uploadsRouteAuth.test.ts
//
// Who may read an uploaded file.
//
// SEC-04: the uploads route used to serve the ENTIRE upload root to anyone,
// protected only by a 48-bit random filename. It then gated every subdir that
// was not explicitly public on a session, and forced SVGs to download.
//
// SEC-04b: a session was the whole gate, so any staff member of any role read
// customer imports and delivery signatures, and inventory photos and ticket
// files were public. Each subdir now takes the key of the screen that shows its
// files (UPLOAD_READ_ACCESS in lib/secureUpload.ts), the route classifies the
// file a request RESOLVES to rather than its first raw segment, and a subdir
// nobody classified is served to nobody.
//
// No database: every case here is decided before the route reads one. The
// permission decisions run against Postgres in
// integration/uploadReadAccess.integration.test.ts.

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

import handler from "@/pages/api/uploads/[...path]";
import {
  UPLOAD_PRESETS,
  UPLOAD_READ_ACCESS,
  UPLOAD_ROOT,
  sendUploadedFile,
  uploadReadAccessFor,
} from "@/lib/secureUpload";
import { isPermissionKey } from "@/lib/auth/permissionCatalog";
import { requirementKeys } from "@/lib/auth/roleDecision";

const sessionMock = getServerSession as jest.Mock;

const FILES = {
  png: ["images", "test-sec04b.png"],
  svg: ["images", "test-sec04b.svg"],
  inventory: ["inventory", "test-sec04b.jpg"],
  attachments: ["attachments", "test-sec04b.pdf"],
  attachmentPng: ["attachments", "test-sec04b.png"],
  imports: ["imports", "test-sec04b.csv"],
  proposals: ["proposals", "9999", "test-sec04b.png"],
  unclassified: ["something-new", "test-sec04b.txt"],
};

const abs = (segments: string[]) => path.join(UPLOAD_ROOT, ...segments);

function makeReq(segments: string[]): NextApiRequest {
  return { method: "GET", query: { path: segments }, cookies: {} } as unknown as NextApiRequest;
}

type TestRes = NextApiResponse & {
  _headers: Record<string, unknown>;
  _status: number;
  _body?: unknown;
  _bytes: Buffer[];
  headersSent: boolean;
  done: Promise<void>;
};

function makeRes(): TestRes {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const bytes: Buffer[] = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      res.headersSent = true;
      bytes.push(Buffer.from(chunk));
      cb();
    },
  }) as unknown as TestRes;
  res.on("finish", () => resolveDone());
  res.on("close", () => resolveDone());
  res._headers = {};
  res._status = 200;
  res._bytes = bytes;
  res.headersSent = false;
  res.done = done;
  res.setHeader = ((k: string, v: unknown) => {
    res._headers[k] = v;
    return res;
  }) as unknown as TestRes["setHeader"];
  res.removeHeader = ((k: string) => {
    delete res._headers[k];
  }) as unknown as TestRes["removeHeader"];
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

async function get(segments: string[]): Promise<TestRes> {
  const res = makeRes();
  await handler(makeReq(segments), res);
  await res.done;
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
    fs.rmSync(abs(seg), { force: true });
  }
  fs.rmSync(abs(["something-new"]), { recursive: true, force: true });
  fs.rmSync(abs(["proposals", "9999"]), { recursive: true, force: true });
});

beforeEach(() => sessionMock.mockReset());

describe("uploadReadAccessFor", () => {
  it.each([
    [["images", "a.jpg"], "public"],
    [["images", "products", "a.jpg"], "public"],
    [["line-drawings", "vendor", "style.png"], "public"],
    [["inventory", "a.jpg"], "inventory.count"],
    [["attachments", "a.pdf"], "service.read"],
    [["proposals", "12", "3-1700000000000.jpg"], "sales.read"],
    [["imports", "customers.csv"], "admin.data"],
    [["pdfs", "book.pdf"], "admin.data"],
    [["delivery-proof", "stop-1-1.png"], "admin.data"],
  ])("%j is %s", (segments, expected) => {
    const access = uploadReadAccessFor(abs(segments as string[]));
    expect(access?.public ? "public" : access?.permission).toBe(expected);
  });

  it.each([
    [["something-new", "x"]],
    [["logo.png"]], // a file at the root sits in no subdir
    [["__proto__", "x"]],
    [["constructor", "x"]],
    [["toString", "x"]],
    [["hasOwnProperty", "x"]],
  ])("%j is classified for nobody", (segments) => {
    expect(uploadReadAccessFor(abs(segments))).toBeNull();
  });

  it("a path outside the upload root is classified for nobody", () => {
    expect(uploadReadAccessFor(path.join(UPLOAD_ROOT, "..", "secrets.txt"))).toBeNull();
    expect(uploadReadAccessFor(path.join(UPLOAD_ROOT, "..", "uploads-other", "a.png"))).toBeNull();
  });
});

describe("uploads route, before any database read", () => {
  it("a public product image is served with no session, with the long public cache", async () => {
    const res = await get(FILES.png);
    expect(res._status).toBe(200);
    expect(res._headers["Content-Type"]).toBe("image/png");
    expect(res._headers["Cache-Control"]).toBe("public, max-age=86400, immutable");
    expect(Buffer.concat(res._bytes).toString()).toBe("x");
    expect(sessionMock).not.toHaveBeenCalled();
  });

  it.each([["inventory"], ["attachments"], ["imports"], ["proposals"]])(
    "a file in %s answers 404 with no session",
    async (key) => {
      sessionMock.mockResolvedValue(null);
      const res = await get(FILES[key as keyof typeof FILES]);
      expect(res._status).toBe(404);
      expect(res._headers["Content-Type"]).toBeUndefined();
    },
  );

  it("a subdir nobody classified answers 404 even with a session", async () => {
    sessionMock.mockResolvedValue({ user: { id: "staff-1", email: "staff@store.test" } });
    const res = await get(FILES.unclassified);
    expect(res._status).toBe(404);
    expect(res._headers["Content-Type"]).toBeUndefined();
  });

  it("is classified by where the path resolves, not its first segment (the %2F re-root)", async () => {
    // Next decodes each catch-all entry after splitting on "/", so
    // /api/uploads/images/%2F<root>%2Fimports%2F<name> arrives as these two
    // segments: a public first segment and an absolute path to a private file.
    sessionMock.mockResolvedValue(null);
    const res = await get(["images", abs(FILES.imports)]);
    expect(res._status).toBe(404);
    expect(res._headers["Content-Type"]).toBeUndefined();
  });

  it("a prototype-named first segment answers 404, even with a session", async () => {
    sessionMock.mockResolvedValue({ user: { id: "staff-1", email: "staff@store.test" } });
    const res = await get(["__proto__", "x"]);
    expect(res._status).toBe(404);
  });

  it("an SVG is forced to download instead of rendering inline", async () => {
    const res = await get(FILES.svg);
    expect(res._headers["Content-Type"]).toBe("application/octet-stream");
    expect(res._headers["Content-Disposition"]).toBe("attachment");
  });

  it("refuses a method other than GET, and a traversal", async () => {
    const post = makeRes();
    await handler(
      { method: "POST", query: { path: FILES.png } } as unknown as NextApiRequest,
      post,
    );
    expect(post._status).toBe(405);

    const traversal = await get(["images", "..", "..", "etc", "passwd"]);
    expect(traversal._status).toBe(400);
  });
});

describe("sendUploadedFile", () => {
  async function send(segments: string[], opts: Parameters<typeof sendUploadedFile>[2]) {
    const res = makeRes();
    sendUploadedFile(res, abs(segments), opts);
    await res.done;
    return res;
  }

  it("names a download only when asked, and only with a safe name", async () => {
    const pdf = await send(FILES.attachments, {
      cache: "private",
      downloadName: "test-sec04b.pdf",
    });
    expect(pdf._headers["Content-Type"]).toBe("application/octet-stream");
    expect(pdf._headers["Content-Disposition"]).toBe('attachment; filename="test-sec04b.pdf"');
    expect(pdf._headers["Cache-Control"]).toBe("private, no-store, max-age=0");

    const image = await send(FILES.attachmentPng, {
      cache: "private",
      downloadName: "test-sec04b.png",
    });
    expect(image._headers["Content-Type"]).toBe("image/png");
    expect(image._headers["Content-Disposition"]).toBe('inline; filename="test-sec04b.png"');

    const unsafe = await send(FILES.attachments, { cache: "private", downloadName: 'a"; x=.pdf' });
    expect(unsafe._headers["Content-Disposition"]).toBe("attachment");

    const unnamed = await send(FILES.attachmentPng, { cache: "private" });
    expect(unnamed._headers["Content-Disposition"]).toBeUndefined();
  });

  it("answers 404 for a file that is not there, or a directory", async () => {
    expect((await send(["attachments", "missing-sec04b.png"], { cache: "private" }))._status).toBe(
      404,
    );
    expect((await send(["attachments"], { cache: "private" }))._status).toBe(404);
  });

  // Root reads a mode-000 file anyway, so the read error cannot be staged there.
  const asNonRoot = process.getuid?.() === 0 ? it.skip : it;
  asNonRoot("a file that cannot be read answers 404, not a hung or broken response", async () => {
    const unreadable = ["attachments", "unreadable-sec04b.png"];
    fs.writeFileSync(abs(unreadable), "x");
    fs.chmodSync(abs(unreadable), 0o000);
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The stat succeeds (it needs no read permission); the open fails.
      const res = await send(unreadable, { cache: "private" });
      expect(res._status).toBe(404);
      expect(res._headers["Content-Length"]).toBeUndefined();
      expect(res._headers["Cache-Control"]).toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("Stored upload could not be read"),
      );
    } finally {
      errorLog.mockRestore();
      fs.rmSync(abs(unreadable), { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 65: UPLOAD_READ_ACCESS is the manifest of every subdir the app writes.
// ---------------------------------------------------------------------------

/** `path.join(..., "data", "uploads", "<subdir>", ...)`: a writer building its own path. */
const PATH_JOIN = /["']data["']\s*,\s*["']uploads["']\s*,\s*["']([\w-]+)["']/g;
/** `` `/uploads/<subdir>/${...}` ``: the URL a writer stores for its file. */
const URL_TEMPLATE = /`\/uploads\/([\w-]+)\//g;

/** The upload subdirs a source text writes to. */
function subdirsWrittenIn(text: string): string[] {
  return [...text.matchAll(PATH_JOIN), ...text.matchAll(URL_TEMPLATE)].map((m) => m[1]);
}

function sourceTexts(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) sourceTexts(p, out);
    else if (/\.tsx?$/.test(name)) out.push(fs.readFileSync(p, "utf8"));
  }
  return out;
}

function subdirsWritten(): string[] {
  const fromPresets = Object.values(UPLOAD_PRESETS).map((p) => p.subdir);
  const fromSource = sourceTexts(path.join(__dirname, "..", "src")).flatMap(subdirsWrittenIn);
  return [...new Set([...fromPresets, ...fromSource])].sort();
}

describe("UPLOAD_READ_ACCESS covers every subdir the app writes (rule 65)", () => {
  it("every written subdir is classified, and every classified subdir is written", () => {
    // Red one way: a new preset or a hand-built path writes a subdir nobody
    // classified, so its files are served to nobody until someone decides.
    // Red the other way: an entry for a subdir nothing writes any more.
    expect(subdirsWritten()).toEqual(Object.keys(UPLOAD_READ_ACCESS).sort());
  });

  it("the scan finds a subdir from each kind of writer", () => {
    // The detector can disagree: it is not merely agreeing with the manifest.
    expect(
      subdirsWrittenIn('const dir = path.join(process.cwd(), "data", "uploads", "receipts");'),
    ).toEqual(["receipts"]);
    expect(subdirsWrittenIn("const url = `/uploads/scans/${name}`;")).toEqual(["scans"]);
    expect(subdirsWrittenIn('const root = path.join(process.cwd(), "data", "uploads");')).toEqual(
      [],
    );
  });

  it("every gated subdir names a real key, and every entry says why", () => {
    for (const [subdir, access] of Object.entries(UPLOAD_READ_ACCESS)) {
      expect({ subdir, reasonLength: access.reason.trim().length >= 10 }).toEqual({
        subdir,
        reasonLength: true,
      });
      if (!access.public) {
        for (const key of requirementKeys(access.permission)) {
          expect({ subdir, key, known: isPermissionKey(key) }).toEqual({
            subdir,
            key,
            known: true,
          });
        }
      }
    }
  });
});

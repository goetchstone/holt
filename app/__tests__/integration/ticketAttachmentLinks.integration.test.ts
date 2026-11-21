// /app/__tests__/integration/ticketAttachmentLinks.integration.test.ts
//
// SEC-04b: a customer opens the files on their own ticket through one-hour,
// one-file links (lib/tickets/attachmentToken.ts), minted by the public status
// GET each time the page loads. Before, the status JSON carried each file's raw
// /uploads/attachments/<name> path and the uploads route served that path to
// anyone. Now the raw path never reaches the public JSON, staff read it on
// "View service", and the link opens only a file in the ticket-attachment
// directory.
//
// Real routes, real database, real files under data/uploads/attachments.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { Readable, Writable } from "stream";
import fs from "fs";
import path from "path";
import { randomBytes } from "node:crypto";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import { signCapabilityToken } from "@/lib/capabilityToken";
import { generateClientPortalToken } from "@/lib/clientPortalToken";
import { generateTicketAttachmentToken } from "@/lib/tickets/attachmentToken";
import { UPLOAD_ROOT } from "@/lib/secureUpload";
import publicTicket from "@/pages/api/tickets/public/[token]";
import publicUpload from "@/pages/api/tickets/public/[token]/attachment";
import fileRoute from "@/pages/api/tickets/public/files/[token]";
import uploadsRoute from "@/pages/api/uploads/[...path]";

const SECRET = "ticket-attachment-links-test-secret";
const savedSecret = process.env.NEXTAUTH_SECRET;
const FILES_PREFIX = "/api/tickets/public/files/";
const EXPIRED =
  "This file link has expired or is not valid. Reload your request page for a fresh one.";

type Captured = {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
  bytes: Buffer;
};

/** A response that records status, headers, a JSON body or streamed bytes. */
function capture() {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const chunks: Buffer[] = [];
  const out: Captured = { status: 200, headers: {}, body: undefined, bytes: Buffer.alloc(0) };
  const res = new Writable({
    write(chunk, _enc, cb) {
      (res as unknown as { headersSent: boolean }).headersSent = true;
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as unknown as NextApiResponse;
  res.on("finish", () => resolveDone());
  res.on("close", () => resolveDone());
  Object.assign(res, {
    headersSent: false,
    setHeader(k: string, v: unknown) {
      out.headers[k] = v;
      return res;
    },
    removeHeader(k: string) {
      delete out.headers[k];
    },
    status(c: number) {
      out.status = c;
      return res;
    },
    json(p: unknown) {
      out.body = JSON.parse(JSON.stringify(p));
      res.end();
      return res;
    },
  });
  return {
    res,
    result: done.then(() => ({ ...out, bytes: Buffer.concat(chunks) })),
  };
}

let ip = 0;
/** A fresh client address per request, so the routes' rate limits never decide a case. */
const socket = () => ({ remoteAddress: `10.0.${Math.floor(++ip / 250)}.${ip % 250}` });

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  req: object,
): Promise<Captured> {
  const { res, result } = capture();
  await route({ headers: {}, cookies: {}, socket: socket(), ...req } as NextApiRequest, res);
  return result;
}

const openFile = (token: string) => call(fileRoute, { method: "GET", query: { token } });

const writeUpload = (subdir: string, name: string, bytes: Buffer) => {
  fs.mkdirSync(path.join(UPLOAD_ROOT, subdir), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_ROOT, subdir, name), bytes);
};
const storedName = (ext: string) => `${Date.now()}-${randomBytes(6).toString("hex")}${ext}`;

describe("customers open their ticket files through expiring per-file links", () => {
  const written: string[] = [];
  const png = { name: storedName(".png"), bytes: randomBytes(64) };
  const pdf = { name: storedName(".pdf"), bytes: Buffer.from("%PDF-1.4 test attachment") };
  let publicToken = "";
  let ticketId = 0;

  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = savedSecret;
    for (const file of written) fs.rmSync(file, { force: true });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTestDb();
    invalidateAppSettingsCache();
    (getServerSession as jest.Mock).mockResolvedValue(null);
    await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
    publicToken = randomBytes(24).toString("base64url");
    const ticket = await prisma.ticket.create({
      data: {
        organizationId: 1,
        ticketNumber: "TKT-261121-001",
        publicToken,
        submitterName: "Dana Client",
        subject: "Scratched table",
      },
    });
    ticketId = ticket.id;
    for (const f of [png, pdf]) {
      writeUpload("attachments", f.name, f.bytes);
      written.push(path.join(UPLOAD_ROOT, "attachments", f.name));
      await prisma.ticketAttachment.create({
        data: {
          ticketId,
          filename: `customer-${f.name.slice(-4)}`,
          url: `/uploads/attachments/${f.name}`,
          mimeType: f.name.endsWith(".pdf") ? "application/pdf" : "image/png",
          uploadedBy: "Dana Client",
        },
      });
    }
  });

  async function statusLinks(): Promise<string[]> {
    const got = await call(publicTicket, { method: "GET", query: { token: publicToken } });
    expect(got.status).toBe(200);
    const { attachments } = (got.body as { ticket: { attachments: Array<{ url: string }> } })
      .ticket;
    return attachments.map((a) => a.url);
  }

  it("the public status JSON carries no raw upload path", async () => {
    const got = await call(publicTicket, { method: "GET", query: { token: publicToken } });
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body)).not.toContain("/uploads/");
    const links = await statusLinks();
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.startsWith(FILES_PREFIX)).toBe(true);
  });

  it("each link opens its own file, privately, under its stored name", async () => {
    const opened: Captured[] = [];
    for (const link of await statusLinks())
      opened.push(await openFile(link.slice(FILES_PREFIX.length)));
    const image = opened.find((o) => o.headers["Content-Type"] === "image/png");
    const document = opened.find((o) => o.headers["Content-Type"] === "application/octet-stream");

    expect(image?.status).toBe(200);
    expect(image?.bytes.equals(png.bytes)).toBe(true);
    expect(image?.headers["Content-Disposition"]).toBe(`inline; filename="${png.name}"`);
    expect(image?.headers["Cache-Control"]).toBe("private, no-store, max-age=0");

    // A PDF is not rendered from our origin: it downloads, under its stored name.
    expect(document?.status).toBe(200);
    expect(document?.bytes.equals(pdf.bytes)).toBe(true);
    expect(document?.headers["Content-Disposition"]).toBe(`attachment; filename="${pdf.name}"`);
    expect(document?.headers["Cache-Control"]).toBe("private, no-store, max-age=0");
  });

  it("a tampered, foreign-family or expired token answers 404 with the reload message", async () => {
    const [link] = await statusLinks();
    const token = link.slice(FILES_PREFIX.length);
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");
    const attachment = await prisma.ticketAttachment.findFirstOrThrow({ where: { ticketId } });

    for (const bad of [
      tampered,
      generateClientPortalToken(attachment.id),
      signCapabilityToken({ attachmentId: attachment.id }, "holt-ticket-attachment", -60),
      "not-a-token",
    ]) {
      const got = await openFile(bad);
      expect(got.status).toBe(404);
      expect(got.body).toEqual({ error: EXPIRED });
      expect(got.bytes).toHaveLength(0);
    }
  });

  it("a token for a deleted attachment answers 404", async () => {
    const attachment = await prisma.ticketAttachment.findFirstOrThrow({ where: { ticketId } });
    const token = generateTicketAttachmentToken(attachment.id);
    await prisma.ticketAttachment.delete({ where: { id: attachment.id } });
    const got = await openFile(token);
    expect(got.status).toBe(404);
    expect(got.bytes).toHaveLength(0);
  });

  it("a row pointing outside the ticket-attachment directory never serves that file", async () => {
    const name = storedName(".csv");
    writeUpload("imports", name, Buffer.from("name,email\nA,a@example.com\n"));
    written.push(path.join(UPLOAD_ROOT, "imports", name));
    const stray = await prisma.ticketAttachment.create({
      data: {
        ticketId,
        filename: "customers.csv",
        url: `/uploads/imports/${name}`,
        mimeType: "text/csv",
      },
    });
    const got = await openFile(generateTicketAttachmentToken(stray.id));
    expect(got.status).toBe(404);
    expect(got.bytes).toHaveLength(0);
  });

  it("is 404 while the helpdesk module is off", async () => {
    const [link] = await statusLinks();
    await prisma.appSettings.create({
      data: { organizationId: 1, appName: "Test Co", features: { helpdesk: false } },
    });
    invalidateAppSettingsCache();
    const got = await openFile(link.slice(FILES_PREFIX.length));
    expect(got.status).toBe(404);
    expect(got.bytes).toHaveLength(0);
  });

  it("the raw /uploads/attachments URL answers 404 without a session", async () => {
    const got = await call(uploadsRoute, {
      method: "GET",
      query: { path: ["attachments", png.name] },
    });
    expect(got.status).toBe(404);
    expect(got.bytes).toHaveLength(0);
  });

  it("the customer's upload answers with a link, not the raw path", async () => {
    const boundary = "----holt-test-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="receipt.png"\r\n' +
          "Content-Type: image/png\r\n\r\n",
      ),
      randomBytes(32),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const req = Object.assign(Readable.from([body], { objectMode: false }), {
      method: "POST",
      query: { token: publicToken },
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
      },
      cookies: {},
      socket: socket(),
    });
    const { res, result } = capture();
    await publicUpload(req as unknown as NextApiRequest, res);
    const got = await result;

    expect(got.status).toBe(201);
    const { attachment } = got.body as { attachment: { id: number; url: string } };
    const row = await prisma.ticketAttachment.findUniqueOrThrow({ where: { id: attachment.id } });
    written.push(path.join(UPLOAD_ROOT, "attachments", path.posix.basename(row.url)));
    expect(row.url.startsWith("/uploads/attachments/")).toBe(true);
    expect(attachment.url.startsWith(FILES_PREFIX)).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain("/uploads/");

    const opened = await openFile(attachment.url.slice(FILES_PREFIX.length));
    expect(opened.status).toBe(200);
    expect(opened.headers["Content-Disposition"]).toBe(
      `inline; filename="${path.posix.basename(row.url)}"`,
    );
  });
});

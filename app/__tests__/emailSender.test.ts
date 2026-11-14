// /app/__tests__/emailSender.test.ts
//
// lib/email/sender.ts over a real SMTP conversation. A minimal SMTP server runs
// in-process on localhost, and sendEmail is pointed at it through the resolved
// config, so what is asserted is what nodemailer actually put on the wire:
// the envelope (MAIL FROM / RCPT TO) and the message (headers, HTML body). It
// was written for the nodemailer 9 -> 10 major (2026-09-30, four advisories)
// and keeps any later major honest the same way: no network, no mail service.

import { startSmtpSink } from "./helpers/smtpSink";

jest.mock("@/lib/email/config", () => ({ getSmtpConfig: jest.fn() }));
jest.mock("@/lib/appSettings", () => ({ DEFAULT_ORG_ID: 1 }));
jest.mock("@/lib/logger", () => ({ logError: jest.fn() }));

import nodemailer from "nodemailer";
import { getSmtpConfig } from "@/lib/email/config";
import { sendEmail } from "@/lib/email/sender";

const configMock = getSmtpConfig as jest.Mock;

function smtpConfig(port: number) {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    user: null,
    pass: null,
    fromAddress: "store@holt.test",
    fromName: "Holt Test Store",
  };
}

let sink: Awaited<ReturnType<typeof startSmtpSink>>;

beforeEach(async () => {
  configMock.mockReset();
  sink = await startSmtpSink();
});

afterEach(async () => {
  await new Promise<void>((resolve) => sink.server.close(() => resolve()));
});

describe("sendEmail over SMTP", () => {
  it("delivers the envelope and the message nodemailer builds", async () => {
    configMock.mockResolvedValue(smtpConfig(sink.port));

    const result = await sendEmail({
      to: "customer@holt.test",
      subject: "Your order is ready",
      html: "<p>Order <strong>SO-1001</strong> is ready for pickup.</p>",
    });

    expect(result).toEqual({ ok: true });
    expect(sink.received.mailFrom).toEqual([expect.stringContaining("<store@holt.test>")]);
    expect(sink.received.rcptTo).toEqual([expect.stringContaining("<customer@holt.test>")]);
    expect(sink.received.data).toHaveLength(1);
    const message = sink.received.data[0];
    expect(message).toMatch(/^From: Holt Test Store <store@holt\.test>$/m);
    expect(message).toMatch(/^To: customer@holt\.test$/m);
    expect(message).toMatch(/^Subject: Your order is ready$/m);
    expect(message).toMatch(/^Content-Type: text\/html/m);
    expect(message).toContain("SO-1001");
  });

  it("sends an attachment as its own part, byte for byte", async () => {
    configMock.mockResolvedValue(smtpConfig(sink.port));
    const content = Buffer.from("%PDF-1.3 a purchase order");

    const result = await sendEmail({
      to: "orders@vendor.test",
      subject: "Purchase order PO-261030-001",
      html: "<p>Attached.</p>",
      attachments: [{ filename: "PO-261030-001.pdf", contentType: "application/pdf", content }],
    });

    expect(result).toEqual({ ok: true });
    const message = sink.received.data[0];
    expect(message).toMatch(/^Content-Type: multipart\/mixed/m);
    expect(message).toMatch(/^Content-Type: application\/pdf; name=PO-261030-001\.pdf$/m);
    expect(message).toMatch(/^Content-Disposition: attachment; filename=PO-261030-001\.pdf$/m);
    expect(message).toContain(content.toString("base64"));
  });

  it("reports a failed connection as an error instead of throwing", async () => {
    // A port nothing listens on: close the sink and reuse its number.
    const port = sink.port;
    await new Promise<void>((resolve) => sink.server.close(() => resolve()));
    sink = await startSmtpSink(); // afterEach closes this one
    configMock.mockResolvedValue({ ...smtpConfig(port), host: "127.0.0.1" });

    const result = await sendEmail({ to: "customer@holt.test", subject: "x", html: "<p>x</p>" });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual(expect.any(String));
  });

  // The transport is cached across sends. Its key left the password out, so a
  // password saved in Settings was ignored until a restart: every send kept
  // using the transport built with the old one.
  it("builds a new transport when only the password or the TLS setting changes", async () => {
    const built = jest.spyOn(nodemailer, "createTransport");
    try {
      const send = () => sendEmail({ to: "a@holt.test", subject: "x", html: "<p>x</p>" });
      configMock.mockResolvedValue({ ...smtpConfig(sink.port), pass: "first" });
      expect((await send()).ok).toBe(true);
      expect((await send()).ok).toBe(true);
      expect(built).toHaveBeenCalledTimes(1);

      configMock.mockResolvedValue({ ...smtpConfig(sink.port), pass: "second" });
      expect((await send()).ok).toBe(true);
      expect(built).toHaveBeenCalledTimes(2);

      // The sink speaks no TLS, so only the transport is built, not the send.
      configMock.mockResolvedValue({ ...smtpConfig(sink.port), pass: "second", secure: true });
      await send();
      expect(built).toHaveBeenCalledTimes(3);
      expect(built.mock.calls[2][0]).toMatchObject({ secure: true });
    } finally {
      built.mockRestore();
    }
  });

  it("skips, without connecting, when SMTP is not configured", async () => {
    configMock.mockResolvedValue(null);

    expect(await sendEmail({ to: "a@holt.test", subject: "x", html: "x" })).toEqual({
      ok: false,
      skipped: true,
    });
    expect(sink.received.mailFrom).toEqual([]);
  });
});

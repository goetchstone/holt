// /app/__tests__/emailSender.test.ts
//
// lib/email/sender.ts over a real SMTP conversation. A minimal SMTP server runs
// in-process on localhost, and sendEmail is pointed at it through the resolved
// config, so what is asserted is what nodemailer actually put on the wire:
// the envelope (MAIL FROM / RCPT TO) and the message (headers, HTML body). It
// was written for the nodemailer 9 -> 10 major (2026-09-30, four advisories)
// and keeps any later major honest the same way: no network, no mail service.

import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

jest.mock("@/lib/email/config", () => ({ getSmtpConfig: jest.fn() }));
jest.mock("@/lib/appSettings", () => ({ DEFAULT_ORG_ID: 1 }));
jest.mock("@/lib/logger", () => ({ logError: jest.fn() }));

import { getSmtpConfig } from "@/lib/email/config";
import { sendEmail } from "@/lib/email/sender";

const configMock = getSmtpConfig as jest.Mock;

interface Received {
  mailFrom: string[];
  rcptTo: string[];
  data: string[];
}

/** Just enough SMTP to accept one message per connection: no STARTTLS, no AUTH. */
function startSmtpSink(): Promise<{ server: Server; port: number; received: Received }> {
  const received: Received = { mailFrom: [], rcptTo: [], data: [] };
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let body = "";
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (inData) {
        body += buffer;
        buffer = "";
        const end = body.indexOf("\r\n.\r\n");
        if (end === -1) return;
        received.data.push(body.slice(0, end));
        buffer = body.slice(end + 5);
        body = "";
        inData = false;
        socket.write("250 2.0.0 queued\r\n");
      }
      let newline: number;
      while (!inData && (newline = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250-sink.test\r\n250 8BITMIME\r\n");
        else if (verb === "MAIL") received.mailFrom.push(line) && socket.write("250 2.1.0 ok\r\n");
        else if (verb === "RCPT") received.rcptTo.push(line) && socket.write("250 2.1.5 ok\r\n");
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 end with <CRLF>.<CRLF>\r\n");
          body = buffer;
          buffer = "";
        } else if (verb === "QUIT") socket.end("221 2.0.0 bye\r\n");
        else if (verb === "RSET" || verb === "NOOP") socket.write("250 2.0.0 ok\r\n");
        else socket.write("502 5.5.2 not implemented\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, received });
    });
  });
}

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

  it("skips, without connecting, when SMTP is not configured", async () => {
    configMock.mockResolvedValue(null);

    expect(await sendEmail({ to: "a@holt.test", subject: "x", html: "x" })).toEqual({
      ok: false,
      skipped: true,
    });
    expect(sink.received.mailFrom).toEqual([]);
  });
});

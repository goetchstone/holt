// /app/__tests__/helpers/smtpSink.ts
//
// Just enough SMTP to accept messages on localhost, for tests that assert what
// nodemailer actually put on the wire: the envelope (MAIL FROM / RCPT TO) and
// each message as sent (headers, body, attachments). No network, no mail
// service. Used by emailSender.test.ts and by the purchase-order email test.

import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface Received {
  mailFrom: string[];
  rcptTo: string[];
  data: string[];
}

/** Just enough SMTP to accept one message per connection: no STARTTLS, no AUTH. */
export function startSmtpSink(): Promise<{ server: Server; port: number; received: Received }> {
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

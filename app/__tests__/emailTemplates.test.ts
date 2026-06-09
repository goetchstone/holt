// /app/__tests__/emailTemplates.test.ts

import {
  bookingConfirmationEmail,
  ticketReceivedEmail,
  ticketReplyEmail,
} from "@/lib/email/templates";

describe("email templates", () => {
  it("booking confirmation includes service, customer, and app name", () => {
    const { subject, html } = bookingConfirmationEmail({
      appName: "Akritos",
      customerName: "Dana",
      serviceName: "Consult",
      startsAt: new Date("2026-06-10T15:00:00Z"),
      timezone: "UTC",
    });
    expect(subject).toContain("Akritos");
    expect(subject).toContain("Consult");
    expect(html).toContain("Dana");
    expect(html).toContain("Consult");
  });

  it("ticket received includes the number + status link", () => {
    const { subject, html } = ticketReceivedEmail({
      appName: "Akritos",
      submitterName: "Dana",
      ticketNumber: "TKT-260604-001",
      subject: "Help me",
      statusUrl: "https://akritos.com/support/abc",
    });
    expect(subject).toContain("TKT-260604-001");
    expect(html).toContain("https://akritos.com/support/abc");
  });

  it("escapes HTML in interpolated values so content can't inject markup", () => {
    const { html } = ticketReplyEmail({
      appName: "Akritos",
      submitterName: "Dana",
      ticketNumber: "TKT-1",
      subject: "x",
      statusUrl: "https://x/y",
      messageBody: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

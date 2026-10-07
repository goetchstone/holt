// /app/__tests__/emailTemplates.test.ts

import {
  bookingConfirmationEmail,
  ticketReceivedEmail,
  ticketReplyEmail,
  invoiceIssuedEmail,
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

describe("invoiceIssuedEmail", () => {
  const base = {
    appName: "Acme Co",
    customerName: "Dana Test",
    invoiceNo: "INV-260610-001",
    totalFormatted: "$1,701.60",
    openBalanceFormatted: "$1,701.60",
    dueDate: new Date(2026, 6, 1),
    lines: [
      { description: "Consulting - June", quantity: 10, amountFormatted: "$1,500.00" },
      { description: "Hosting", quantity: 1, amountFormatted: "$100.00" },
    ],
  };

  it("renders subject, total, due date, and line rows", () => {
    const { subject, html } = invoiceIssuedEmail({ ...base, paymentUrl: null });
    expect(subject).toBe("Invoice INV-260610-001 from Acme Co");
    expect(html).toContain("$1,701.60");
    expect(html).toContain("Consulting - June");
    expect(html).toContain("Hosting");
    expect(html).toContain("July 1, 2026");
    expect(html).not.toContain("Pay ");
  });

  it("embeds the pay button only when a payment URL is provided", () => {
    const { html } = invoiceIssuedEmail({
      ...base,
      paymentUrl: "https://checkout.stripe.com/pay/cs_123",
    });
    expect(html).toContain("https://checkout.stripe.com/pay/cs_123");
    expect(html).toContain("Pay $1,701.60 now");
  });

  it("HTML-escapes customer-controlled text", () => {
    const { html } = invoiceIssuedEmail({
      ...base,
      customerName: '<script>alert("x")</script>',
      lines: [{ description: "<img src=x>", quantity: 1, amountFormatted: "$1.00" }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// /app/__tests__/opsAlert.test.ts
//
// Pure tests for the ops-alert helpers. The IO path (reportOpsAlert) is a thin
// shell over these + fetch/enqueueEmail; the value worth pinning is the channel
// resolution (empty env = no channel, never a crash) and the payload shapes.

import {
  resolveOpsAlertChannels,
  buildWebhookPayload,
  buildAlertEmail,
} from "@/lib/opsAlert";

describe("resolveOpsAlertChannels", () => {
  it("returns no channels when nothing is configured", () => {
    expect(resolveOpsAlertChannels({} as unknown as NodeJS.ProcessEnv)).toEqual({});
  });

  it("treats empty/whitespace env vars as unset", () => {
    const env = { OPS_ALERT_WEBHOOK: "  ", OPS_ALERT_EMAIL: "" } as unknown as NodeJS.ProcessEnv;
    expect(resolveOpsAlertChannels(env)).toEqual({});
  });

  it("picks up and trims both channels", () => {
    const env = {
      OPS_ALERT_WEBHOOK: " https://hooks.example/x ",
      OPS_ALERT_EMAIL: " ops@example.com ",
    } as unknown as NodeJS.ProcessEnv;
    expect(resolveOpsAlertChannels(env)).toEqual({
      webhook: "https://hooks.example/x",
      email: "ops@example.com",
    });
  });
});

describe("buildWebhookPayload", () => {
  it("carries a flat text field plus structured fields", () => {
    const payload = buildWebhookPayload({
      title: "Cron failed",
      detail: "email-queue returned 500",
      context: { job: "email-queue" },
    });
    expect(payload.text).toContain("[Holt ops] Cron failed");
    expect(payload.text).toContain("email-queue returned 500");
    expect(payload.title).toBe("Cron failed");
    expect(payload.context).toEqual({ job: "email-queue" });
  });

  it("omits context when not provided", () => {
    const payload = buildWebhookPayload({ title: "t", detail: "d" });
    expect(payload).not.toHaveProperty("context");
  });
});

describe("buildAlertEmail", () => {
  it("escapes html in the detail and renders context as a block", () => {
    const { subject, html } = buildAlertEmail({
      title: "Ledger drift",
      detail: "books <out> of sync & late",
      context: { paymentId: 7 },
    });
    expect(subject).toBe("[Holt ops] Ledger drift");
    expect(html).toContain("&lt;out&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("paymentId");
    // raw angle brackets from the detail must not leak through
    expect(html).not.toContain("<out>");
  });

  it("omits the context block when there is no context", () => {
    const { html } = buildAlertEmail({ title: "t", detail: "d" });
    expect(html).not.toContain("<pre>");
  });
});

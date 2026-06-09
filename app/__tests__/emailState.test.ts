// /app/__tests__/emailState.test.ts

import { nextEmailState, MAX_EMAIL_ATTEMPTS } from "@/lib/email/state";

const NOW = new Date("2026-06-04T00:00:00Z");

describe("nextEmailState", () => {
  it("marks SENT with sentAt on success", () => {
    expect(nextEmailState(0, true, NOW)).toEqual({
      status: "SENT",
      attempts: 1,
      sentAt: NOW,
      lastError: null,
    });
  });

  it("stays PENDING and records the error on an early failure", () => {
    const s = nextEmailState(0, false, NOW, "smtp down");
    expect(s.status).toBe("PENDING");
    expect(s.attempts).toBe(1);
    expect(s.lastError).toBe("smtp down");
    expect(s.sentAt).toBeNull();
  });

  it("becomes FAILED once attempts hit the cap", () => {
    const s = nextEmailState(MAX_EMAIL_ATTEMPTS - 1, false, NOW);
    expect(s.status).toBe("FAILED");
    expect(s.attempts).toBe(MAX_EMAIL_ATTEMPTS);
  });
});

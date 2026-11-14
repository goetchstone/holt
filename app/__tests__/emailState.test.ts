// /app/__tests__/emailState.test.ts

import {
  isClaimedElsewhere,
  nextEmailState,
  MAX_EMAIL_ATTEMPTS,
  SEND_CLAIM_LEASE_MS,
} from "@/lib/email/state";

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

// What stops a screen's send-now sending a row a second time while another drain
// is sending it (lib/email/queue.ts, lib/sms/queue.ts): the claim's lease puts
// scheduledAt well in the future, and only that counts as claimed.
describe("isClaimedElsewhere", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it("is true for a claim's lease", () => {
    expect(isClaimedElsewhere(at(SEND_CLAIM_LEASE_MS), NOW)).toBe(true);
  });

  it("is false for a row that is due, or due a moment from now", () => {
    expect(isClaimedElsewhere(at(-5_000), NOW)).toBe(false);
    expect(isClaimedElsewhere(NOW, NOW)).toBe(false);
    // A clock between an app process and the database can be a little apart.
    expect(isClaimedElsewhere(at(30_000), NOW)).toBe(false);
  });

  it("is false once the lease has run out", () => {
    expect(isClaimedElsewhere(at(-1_000), NOW)).toBe(false);
  });
});

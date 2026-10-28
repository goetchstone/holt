// /app/__tests__/openCheckoutPrompt.test.ts
//
// The customer portals turn a 409 "checkout already open" into a confirm in
// plain words. openCheckoutFrom decides whether a response is that refusal;
// customerRetryPrompt words it.

import { customerRetryPrompt, openCheckoutFrom } from "@/lib/openCheckoutPrompt";

const usd = (n: number) => `$${n.toFixed(2)}`;

describe("openCheckoutFrom", () => {
  it("reads the open checkout from a 409 body", () => {
    expect(
      openCheckoutFrom({
        error: "A payment of $400.00 is already in progress",
        existingPayment: { id: 7, amount: 400, ageMinutes: 12, createdAt: "2026-10-28T10:00:00Z" },
      }),
    ).toEqual({ amount: 400, ageMinutes: 12 });
  });

  it.each([
    ["no body", null],
    ["an ordinary error", { error: "No balance due on this order" }],
    ["a malformed existingPayment", { existingPayment: { amount: "400", ageMinutes: 12 } }],
  ])("is null for %s", (_label, body) => {
    expect(openCheckoutFrom(body)).toBeNull();
  });
});

describe("customerRetryPrompt", () => {
  it.each([
    [0, "You started a payment of $400.00 just now."],
    [1, "You started a payment of $400.00 1 minute ago."],
    [12, "You started a payment of $400.00 12 minutes ago."],
    [60, "You started a payment of $400.00 1 hour ago."],
    [190, "You started a payment of $400.00 3 hours ago."],
  ])("after %i minutes reads %p", (ageMinutes, opening) => {
    const text = customerRetryPrompt({ amount: 400, ageMinutes }, usd);
    expect(text).toBe(`${opening} If you didn't finish it, start a new one?`);
    expect(text).not.toMatch(/force/i);
  });
});

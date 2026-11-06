// /app/__tests__/lib/messages/customerMessages.test.ts
//
// GAP-13: the pure parts of the automatic customer messages -- what a store's
// wording may say (lib/messages/catalog.ts), how it is filled and escaped
// (render.ts, email/templates.ts), and when a timed one is due on the store's
// clock (timing.ts).

import { DEFAULT_EMAIL_LOOK } from "@/lib/email/look";
import {
  MESSAGE_CATALOG,
  messageSettingProblem,
  unknownPlaceholders,
  type MessageSettingInput,
} from "@/lib/messages/catalog";
import {
  customerName,
  describePieces,
  describeWhen,
  fillPlaceholders,
  renderCustomerMessage,
} from "@/lib/messages/render";
import { reminderDueAt, reviewDueAt, runDay } from "@/lib/messages/timing";
import { businessHourStart } from "@/lib/reports/businessDay";

const TZ = "America/New_York";

function input(
  kind: keyof typeof MESSAGE_CATALOG,
  patch: Partial<MessageSettingInput> = {},
): MessageSettingInput {
  return {
    isActive: false,
    linkUrl: null,
    channel: "EMAIL",
    ...MESSAGE_CATALOG[kind].defaults,
    ...patch,
  };
}

describe("what a store's wording may say", () => {
  it("accepts every message's suggested wording", () => {
    for (const kind of Object.keys(MESSAGE_CATALOG) as (keyof typeof MESSAGE_CATALOG)[]) {
      expect(messageSettingProblem(kind, input(kind))).toBeNull();
    }
  });

  it("names a placeholder the message can't fill", () => {
    expect(unknownPlaceholders("ARRIVED", "On {when} for {customer} and {Pieces}")).toEqual([
      "{when}",
      "{Pieces}",
    ]);
    expect(messageSettingProblem("ARRIVED", input("ARRIVED", { subject: "{when}" }))).toMatch(
      /can't fill \{when\}/,
    );
  });

  it("needs a subject and wording, within their limits", () => {
    expect(messageSettingProblem("ARRIVED", input("ARRIVED", { subject: "  " }))).toMatch(
      /subject/,
    );
    expect(messageSettingProblem("ARRIVED", input("ARRIVED", { body: "x".repeat(4001) }))).toMatch(
      /under 4000/,
    );
  });

  it("needs a timed message's days and hour, in range", () => {
    expect(
      messageSettingProblem("DELIVERY_REMINDER", input("DELIVERY_REMINDER", { offsetDays: null })),
    ).toMatch(/before the delivery/);
    expect(
      messageSettingProblem("REVIEW_INVITE", input("REVIEW_INVITE", { offsetDays: 2.5 })),
    ).toMatch(/after the handover/);
    expect(
      messageSettingProblem("REVIEW_INVITE", input("REVIEW_INVITE", { offsetDays: 91 })),
    ).toMatch(/0 to 90/);
    expect(
      messageSettingProblem("DELIVERY_REMINDER", input("DELIVERY_REMINDER", { sendHour: 24 })),
    ).toMatch(/hour/);
    // A message that goes at once has no timing to check.
    expect(messageSettingProblem("ARRIVED", input("ARRIVED", { sendHour: 99 }))).toBeNull();
  });

  it("switches the review invitation on only with an https review page", () => {
    expect(messageSettingProblem("REVIEW_INVITE", input("REVIEW_INVITE"))).toBeNull();
    expect(
      messageSettingProblem("REVIEW_INVITE", input("REVIEW_INVITE", { isActive: true })),
    ).toMatch(/review page/);
    expect(
      messageSettingProblem(
        "REVIEW_INVITE",
        input("REVIEW_INVITE", { isActive: true, linkUrl: "javascript:alert(1)" }),
      ),
    ).toMatch(/https/);
    expect(
      messageSettingProblem(
        "REVIEW_INVITE",
        input("REVIEW_INVITE", { isActive: true, linkUrl: "https://example.com/r" }),
      ),
    ).toBeNull();
  });
});

describe("filling and escaping", () => {
  it("fills in one pass, so a value is printed as typed", () => {
    expect(
      fillPlaceholders("Hi {customer}, re {order}", { customer: "{order}", order: "SO-9" }),
    ).toBe("Hi {order}, re SO-9");
    // A placeholder with no value given stays as written.
    expect(fillPlaceholders("{when}", {})).toBe("{when}");
  });

  it("greets by first name, else full name, else 'there'", () => {
    expect(customerName({ firstName: " Jo ", lastName: "Ames" })).toBe("Jo");
    expect(customerName({ firstName: null, lastName: "Ames" })).toBe("Ames");
    expect(customerName({ firstName: "", lastName: null })).toBe("there");
  });

  it("lists pieces with their quantities", () => {
    expect(describePieces([{ name: "Sofa", quantity: 1 }])).toBe("Sofa");
    expect(
      describePieces([
        { name: "Sofa", quantity: 1 },
        { name: "Chair", quantity: 2 },
        { name: "Rug", quantity: 1.5 },
      ]),
    ).toBe("Sofa, 2 × Chair and 1.5 × Rug");
    expect(describePieces([])).toBe("");
  });

  it("says the delivery day, with its window when there is one", () => {
    expect(describeWhen("2031-06-12", null, "en-US")).toBe("Thursday, June 12");
    expect(describeWhen("2031-06-12", " 9am-12pm ", "en-US")).toBe("Thursday, June 12, 9am-12pm");
  });

  it("escapes the store's wording and the customer's name, keeps paragraphs, and adds the buttons", () => {
    const email = renderCustomerMessage({
      look: DEFAULT_EMAIL_LOOK,
      subject: "Order {order}\r\nBcc: x@example.com",
      body: "Hi {customer},\n\nLine one\nline <b>two</b>",
      storeName: "A&B Home",
      values: { customer: "<script>alert(1)</script>", order: "SO-1" },
      orderUrl: "https://holt.example.com/portal/order?token=a&b",
      reviewUrl: "https://reviews.example.com/r",
    });
    expect(email.subject).toBe("Order SO-1 Bcc: x@example.com");
    expect(email.html).toContain("<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;,</p>");
    expect(email.html).toContain("<p>Line one<br>line &lt;b&gt;two&lt;/b&gt;</p>");
    expect(email.html).toContain("A&amp;B Home");
    expect(email.html).toContain("Sent by A&amp;B Home.</p>");
    expect(email.html).toContain('href="https://holt.example.com/portal/order?token=a&amp;b"');
    expect(email.html.indexOf("Leave a review")).toBeLessThan(
      email.html.indexOf("View your order"),
    );
  });

  it("signs with one full stop when the store's name ends in one", () => {
    const email = renderCustomerMessage({
      look: DEFAULT_EMAIL_LOOK,
      subject: "s",
      body: "b",
      storeName: "Holt Home & Rug Co.",
      values: {},
      orderUrl: null,
      reviewUrl: null,
    });
    expect(email.html).toContain("Sent by Holt Home &amp; Rug Co.</p>");
  });

  it("has no buttons when the message carries no links", () => {
    const email = renderCustomerMessage({
      look: DEFAULT_EMAIL_LOOK,
      subject: "s",
      body: "b",
      storeName: "S",
      values: {},
      orderUrl: null,
      reviewUrl: null,
    });
    expect(email.html).not.toContain("<a ");
  });
});

describe("when a timed message is due, on the store's clock", () => {
  it("reads a run's day as dispatch stored it", () => {
    expect(runDay(new Date("2031-06-12T00:00:00.000Z"))).toBe("2031-06-12");
  });

  it("puts 9 am at 9 am on both sides of a clock change", () => {
    // 2026-03-08: clocks go forward in New York (UTC-5 to UTC-4).
    expect(businessHourStart("2026-03-08", 9, TZ).toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(businessHourStart("2026-03-07", 9, TZ).toISOString()).toBe("2026-03-07T14:00:00.000Z");
    // 2026-11-01: clocks go back.
    expect(businessHourStart("2026-11-01", 9, TZ).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("sends a reminder at its hour, its days before the delivery", () => {
    expect(reminderDueAt("2026-11-02", 1, 9, TZ).toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(reminderDueAt("2026-11-02", 0, 7, TZ).toISOString()).toBe("2026-11-02T12:00:00.000Z");
  });

  it("counts a review invitation's days from the handover's day in the store, not in UTC", () => {
    // Handed over at 9 pm New York, which is already the next day in UTC.
    const at = new Date("2031-06-03T01:00:00.000Z");
    expect(reviewDueAt(at, 3, 10, TZ).toISOString()).toBe("2031-06-05T14:00:00.000Z");
  });
});

// /app/__tests__/lib/sms/sms.test.ts
//
// GAP-12: the pure parts of texting -- a customer's free-text phone as E.164,
// Twilio's webhook signature and what its webhooks mean, how a message picks its
// channels, and the opt-out notice a text always carries.

import { isE164, toE164 } from "@/lib/sms/phone";
import { twilioProvider, twilioSignature } from "@/lib/sms/twilio";
import { MESSAGE_CATALOG, channelsFor, messageSettingProblem } from "@/lib/messages/catalog";
import type { MessageSettingInput } from "@/lib/messages/catalog";
import { STOP_NOTICE, renderTextMessage } from "@/lib/messages/render";

describe("a phone as E.164", () => {
  it("reads a North American number where the store's locale says so", () => {
    for (const raw of ["(687) 555-1817", "687.555.1817", "687 555 1817", "1-687-555-1817"]) {
      expect(toE164(raw, "en-US")).toBe("+16875551817");
    }
    expect(toE164("6875551817", "en-CA")).toBe("+16875551817");
  });

  it("takes a number typed with its country code anywhere", () => {
    expect(toE164("+44 20 7946 0958", "en-GB")).toBe("+442079460958");
    expect(toE164("+1 (687) 555-1817", "en-US")).toBe("+16875551817");
  });

  it("doesn't guess a country for a store elsewhere (rule 63)", () => {
    expect(toE164("6875551817", "en-GB")).toBeNull();
    expect(toE164("6875551817", "not a locale")).toBeNull();
    expect(toE164("6875551817", "en")).toBeNull();
  });

  it("refuses what can't take a text", () => {
    for (const raw of [null, undefined, "", "  ", "555-1817", "687 555 1817 x12", "ext 4", "n/a"]) {
      expect(toE164(raw, "en-US")).toBeNull();
    }
    // Read as digits alone, an extension makes a plausible number that isn't theirs.
    expect(toE164("555 1817 x123", "en-US")).toBeNull();
    expect(toE164("+1 687 555 1817 x2", "en-US")).toBeNull();
    expect(toE164("555-1817 #123", "en-US")).toBeNull();
    // No area code starts with 0 or 1.
    expect(toE164("187 555 1817", "en-US")).toBeNull();
    expect(toE164("+0123456789", "en-US")).toBeNull();
    expect(toE164("+12", "en-US")).toBeNull();
  });

  it("says what is E.164", () => {
    expect(isE164("+16875551817")).toBe(true);
    expect(isE164("16875551817")).toBe(false);
    expect(isE164(16875551817)).toBe(false);
  });
});

describe("Twilio's webhook signature", () => {
  const URL_ = "https://example.com/myapp.php?foo=1&bar=2";

  it("reproduces Twilio's worked example", () => {
    // Token, URL, parameters and signature as published at
    // twilio.com/docs/usage/security: computed outside this code, so it can
    // disagree with it.
    expect(
      twilioSignature("12345", URL_, {
        CallSid: "CA1234567890ABCDE",
        Caller: "+14158675310",
        Digits: "1234",
        From: "+14158675310",
        To: "+18005551212",
      }),
    ).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=");
  });

  it("sorts by parameter name, whatever order they came in", () => {
    const a = twilioSignature("t", URL_, { B: "2", A: "1" });
    expect(twilioSignature("t", URL_, { A: "1", B: "2" })).toBe(a);
    expect(twilioSignature("t", URL_, { A: "2", B: "1" })).not.toBe(a);
  });

  it("signs a repeated parameter's values deduplicated and sorted, as Twilio's SDK does", () => {
    expect(twilioSignature("t", URL_, { M: ["b", "a", "b"] })).toBe(
      twilioSignature("t", `${URL_}MaMb`, {}),
    );
  });
});

describe("what a Twilio webhook means", () => {
  const parse = twilioProvider.parseWebhook;
  const FROM = "+16875551817";

  it("reads Twilio's opt-out words in any case, and only as the whole message", () => {
    for (const body of [
      "STOP",
      "stop",
      " Stop ",
      "UNSUBSCRIBE",
      "cancel",
      "END",
      "quit",
      "STOPALL",
    ]) {
      expect(parse({ From: FROM, Body: body })).toEqual({ kind: "opt-out", phone: FROM });
    }
    for (const body of ["stop please", "Please stop", "when will it arrive", ""]) {
      expect(parse({ From: FROM, Body: body })).toEqual({ kind: "other" });
    }
  });

  it("reads START and UNSTOP as opting back in, but not YES, which a toll-free number ignores", () => {
    expect(parse({ From: FROM, Body: "start" })).toEqual({ kind: "opt-in", phone: FROM });
    expect(parse({ From: FROM, Body: "UNSTOP" })).toEqual({ kind: "opt-in", phone: FROM });
    expect(parse({ From: FROM, Body: "yes" })).toEqual({ kind: "other" });
  });

  it("trusts OptOutType over the words, since a store can change its keywords", () => {
    expect(parse({ From: FROM, Body: "basta", OptOutType: "STOP" })).toEqual({
      kind: "opt-out",
      phone: FROM,
    });
    expect(parse({ From: FROM, Body: "again", OptOutType: "START" })).toEqual({
      kind: "opt-in",
      phone: FROM,
    });
    expect(parse({ From: FROM, Body: "stop", OptOutType: "HELP" })).toEqual({ kind: "other" });
  });

  it("ignores a sender that isn't a phone number", () => {
    expect(parse({ From: "whatsapp:+16875551817", Body: "STOP" })).toEqual({ kind: "other" });
  });

  it("reads delivery reports", () => {
    expect(parse({ MessageSid: "SM1", MessageStatus: "delivered" })).toEqual({
      kind: "delivered",
      providerMessageId: "SM1",
    });
    expect(parse({ MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30034" })).toEqual({
      kind: "undelivered",
      providerMessageId: "SM1",
      error: expect.stringContaining("30034"),
    });
    expect(parse({ MessageSid: "SM1", MessageStatus: "failed" })).toMatchObject({
      kind: "undelivered",
    });
    expect(parse({ MessageSid: "SM1", MessageStatus: "sent" })).toEqual({ kind: "other" });
    expect(parse({ MessageStatus: "delivered" })).toEqual({ kind: "other" });
  });
});

describe("how a message picks its channels", () => {
  it("does what the store set", () => {
    expect(channelsFor("EMAIL", "TEXT")).toEqual({ email: true, text: false });
    expect(channelsFor("TEXT", "EMAIL")).toEqual({ email: false, text: true });
    expect(channelsFor("BOTH", null)).toEqual({ email: true, text: true });
  });

  it("follows the customer when the store says to, and is email with no preference", () => {
    expect(channelsFor("CUSTOMER", "TEXT")).toEqual({ email: false, text: true });
    expect(channelsFor("CUSTOMER", "EMAIL")).toEqual({ email: true, text: false });
    expect(channelsFor("CUSTOMER", "BOTH")).toEqual({ email: true, text: true });
    expect(channelsFor("CUSTOMER", null)).toEqual({ email: true, text: false });
    expect(channelsFor("CUSTOMER", undefined)).toEqual({ email: true, text: false });
  });
});

describe("a text's wording", () => {
  function input(patch: Partial<MessageSettingInput> = {}): MessageSettingInput {
    return {
      isActive: false,
      linkUrl: null,
      channel: "TEXT",
      ...MESSAGE_CATALOG.ARRIVED.defaults,
      ...patch,
    };
  }

  it("is checked like the email's", () => {
    expect(messageSettingProblem("ARRIVED", input())).toBeNull();
    expect(messageSettingProblem("ARRIVED", input({ textBody: " " }))).toMatch(/wording/);
    expect(messageSettingProblem("ARRIVED", input({ textBody: "x".repeat(641) }))).toMatch(
      /under 640/,
    );
    expect(messageSettingProblem("ARRIVED", input({ textBody: "On {when}" }))).toMatch(
      /can't fill \{when\}/,
    );
    expect(messageSettingProblem("ARRIVED", input({ channel: "PIGEON" as never }))).toMatch(
      /how the message goes/,
    );
  });

  it("isn't needed by a message that goes only by email", () => {
    expect(messageSettingProblem("ARRIVED", input({ channel: "EMAIL", textBody: "" }))).toBeNull();
  });

  it("always says how to opt out, unless the store's own wording does", () => {
    const render = (body: string, customer = "Jo") =>
      renderTextMessage({ body, values: { customer }, orderUrl: null, reviewUrl: null });
    expect(render("Hi {customer}")).toBe(`Hi Jo\n${STOP_NOTICE}`);
    expect(render("Hi {customer}. Text STOP to end these.")).toBe("Hi Jo. Text STOP to end these.");
    // A customer's name doesn't count as the store saying it.
    expect(render("Hi {customer}", "Stop")).toBe(`Hi Stop\n${STOP_NOTICE}`);
    // Nor does a word that only contains it.
    expect(render("Your nonstop deal")).toContain(STOP_NOTICE);
  });

  it("puts the links on their own lines, before the notice", () => {
    expect(
      renderTextMessage({
        body: "Thanks",
        values: {},
        orderUrl: "https://holt.example.com/o",
        reviewUrl: "https://reviews.example.com/r",
      }),
    ).toBe(`Thanks\nhttps://reviews.example.com/r\nhttps://holt.example.com/o\n${STOP_NOTICE}`);
  });

  it("gives every message suggested wording of its own", () => {
    for (const def of Object.values(MESSAGE_CATALOG)) {
      expect(def.defaults.textBody).toContain("{store}");
      expect(def.defaults.textBody.length).toBeLessThan(160);
    }
  });
});

// __tests__/emailLook.test.ts
//
// A store's look reaches every email, and its wording every email it can word (GAP-37).
// The sample of each email runs the real template, so a template that ignored the look
// fails here. The list of templates is read from the file, so a new one has to join in.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_EMAIL_ACCENT,
  DEFAULT_EMAIL_LOOK,
  absoluteLogoUrl,
  isEmailColor,
  readEmailLook,
  textOn,
  type EmailLook,
} from "@/lib/email/look";
import { sampleCustomerMessage, sampleEmail } from "@/lib/email/samples";
import { fillPlaceholders, placeholdersIn } from "@/lib/email/fill";
import {
  bookingConfirmationEmail,
  followUpEmail,
  passwordResetEmail,
  DEFAULT_EMAIL_CHROME,
  type EmailChrome,
} from "@/lib/email/templates";
import {
  EMAIL_CATALOG,
  EMAIL_KINDS,
  EMAIL_WORDING_MAX,
  EMAIL_SUBJECT_MAX,
  emailText,
  emailWordingProblem,
  isEmailKind,
} from "@/lib/email/wordingCatalog";

const STORE = "A&B Home";
const LOOK: EmailLook = {
  accent: "#7a3e1d",
  logoUrl: "https://store.example.com/logo.png",
  footer: "Line one\nLine <b>two</b>",
};
const chromeWith = (over: Partial<EmailChrome> = {}): EmailChrome => ({
  look: LOOK,
  wording: {},
  ...over,
});

describe("every email takes the store's look", () => {
  const all = [
    ...EMAIL_KINDS.map((kind) => [kind, () => sampleEmail(kind, STORE, chromeWith())] as const),
    ["customer message", () => sampleCustomerMessage(STORE, LOOK)] as const,
  ];

  it.each(all)("%s has the store's logo and foot", (_kind, render) => {
    const { html } = render();
    expect(html).toContain('src="https://store.example.com/logo.png"');
    expect(html).toContain('alt="A&amp;B Home"');
    expect(html).toContain("Line one<br>Line &lt;b&gt;two&lt;/b&gt;");
    expect(html).not.toContain("Sent by");
  });

  it.each(all)("%s doesn't keep the default colour anywhere", (_kind, render) => {
    expect(render().html.toLowerCase()).not.toContain(DEFAULT_EMAIL_ACCENT);
  });

  it.each(
    EMAIL_KINDS.filter((kind) => !["booking", "purchase-order"].includes(kind)).map((kind) => [
      kind,
    ]),
  )("%s uses the store's colour", (kind) => {
    expect(sampleEmail(kind, STORE, chromeWith()).html).toContain("#7a3e1d");
  });

  it("colours the store's name when there's no logo", () => {
    const look = { ...LOOK, logoUrl: null };
    const { html } = sampleEmail("invoice", STORE, { look, wording: {} });
    expect(html).toMatch(/<h1 style="[^"]*color:#7a3e1d[^"]*">A&amp;B Home<\/h1>/);
  });

  it("can't be broken out of by a logo's address", () => {
    const look = { ...LOOK, logoUrl: 'https://x.example.com/a.png" onerror="alert(1)' };
    const { html } = sampleEmail("invoice", STORE, { look, wording: {} });
    expect(html).not.toContain('" onerror="');
    expect(html).toContain("&quot; onerror=&quot;");
  });

  it("with the default look, names the store at the top and says who sent it", () => {
    const { html } = sampleEmail("invoice", STORE, DEFAULT_EMAIL_CHROME);
    expect(html).toContain(">A&amp;B Home</h1>");
    expect(html).toContain("Sent by A&amp;B Home.");
    expect(html).not.toContain("<img");
  });

  it("lists every template in the catalog", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "src", "lib", "email", "templates.ts"),
      "utf8",
    );
    const templates = [...source.matchAll(/^export function (\w+Email)\(/gm)].map((m) => m[1]);
    expect(templates.sort()).toEqual(
      [
        "bookingConfirmationEmail",
        "customerMessageEmail",
        "followUpEmail",
        "invoiceIssuedEmail",
        "lowStockEmail",
        "passwordResetEmail",
        "purchaseOrderEmail",
        "ticketReceivedEmail",
        "ticketReplyEmail",
      ].sort(),
    );
  });
});

describe("every sender uses its own email's wording", () => {
  const SRC = path.join(__dirname, "..", "src");
  it.each([
    ["pages/api/bookings/index.ts", "booking"],
    ["pages/api/tickets/index.ts", "ticket-received"],
    ["pages/api/tickets/[id]/messages.ts", "ticket-reply"],
    ["pages/api/auth/forgot-password.ts", "password-reset"],
    ["pages/api/purchasing/orders/[id]/email.ts", "purchase-order"],
    ["lib/purchasing/lowStockAlert.ts", "low-stock"],
    ["lib/followUpEmail.ts", "follow-up"],
    ["lib/billing/invoiceEmail.ts", "invoice"],
  ])("%s", (file, kind) => {
    expect(readFileSync(path.join(SRC, file), "utf8")).toContain(`getEmailChrome("${kind}")`);
  });
});

describe("a store's wording", () => {
  it.each(EMAIL_KINDS.map((kind) => [kind]))("%s can change all four parts", (kind) => {
    const wording = { subject: "SUBJ", heading: "HEAD", intro: "OPENS", closing: "CLOSES" };
    const { subject, html } = sampleEmail(kind, STORE, chromeWith({ wording }));
    expect(subject).toBe("SUBJ");
    expect(html).toContain(">HEAD</h2>");
    expect(html).toContain("<p>OPENS</p>");
    expect(html).toContain("<p>CLOSES</p>");
  });

  it.each(EMAIL_KINDS.map((kind) => [kind]))("%s uses only placeholders it has", (kind) => {
    const info = EMAIL_CATALOG[kind];
    for (const text of [info.subject, info.heading, info.intro, info.closing]) {
      for (const name of placeholdersIn(text))
        expect(Object.keys(info.placeholders)).toContain(name);
    }
    expect(emailWordingProblem(kind, info)).toBeNull();
  });

  it.each(EMAIL_KINDS.map((kind) => [kind]))("%s fills in everything it suggests", (kind) => {
    const { subject, html } = sampleEmail(kind, STORE, chromeWith());
    expect(subject).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(html).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("keeps what a store didn't change as suggested", () => {
    const text = emailText(
      "invoice",
      { closing: "Thanks!" },
      {
        customer: "Sam",
        invoice: "INV-1",
        total: "$5",
        store: "Home",
      },
    );
    expect(text.subject).toBe("Invoice INV-1 from Home");
    expect(text.closing).toBe("Thanks!");
  });

  it("a blank closing leaves nothing behind", () => {
    const { html } = sampleEmail("booking", STORE, chromeWith({ wording: { closing: "" } }));
    expect(html).not.toContain("We look forward");
    expect(html).not.toContain("<p></p>");
  });

  it("can't drop a password reset's link", () => {
    const { html } = passwordResetEmail({
      appName: "Home",
      displayName: "Pat",
      resetUrl: "https://store.example.com/reset?token=abc",
      chrome: chromeWith({ wording: { intro: "x", closing: "y" } }),
    });
    expect(html).toContain("https://store.example.com/reset?token=abc");
  });

  it("escapes what a store types and what a customer's name holds", () => {
    const { subject, html } = bookingConfirmationEmail({
      appName: "Home",
      customerName: "<img src=x>",
      startsAt: new Date("2026-03-10T15:00:00Z"),
      timezone: "UTC",
      chrome: chromeWith({ wording: { intro: "<b>Hi</b> {customer}", heading: "<i>H</i>" } }),
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>Hi</b>");
    expect(html).not.toContain("<i>H</i>");
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt; &lt;img src=x&gt;");
    expect(subject).toContain("booking");
  });

  it("reads a value once, so a customer named {store} is printed as typed", () => {
    const text = emailText(
      "booking",
      {},
      { customer: "{store}", service: "booking", store: "Home" },
    );
    expect(text.intro).toContain("Hi {store},");
    expect(fillPlaceholders("{a} {b}", { a: "{b}", b: "x" })).toBe("{b} x");
  });

  it("keeps a subject on one line", () => {
    const text = emailText(
      "invoice",
      { subject: "Line\nBcc: x@example.com" },
      {
        customer: "",
        invoice: "",
        total: "",
        store: "",
      },
    );
    expect(text.subject).toBe("Line Bcc: x@example.com");
  });

  it("the morning email still says nothing when there's nothing to say", () => {
    const empty = followUpEmail({
      chrome: chromeWith({ wording: { intro: "Hello" } }),
      storeName: "Home",
      staffName: "Pat",
      baseUrl: "https://store.example.com",
      due: [],
      quotesWaiting: 0,
      suggested: [],
      suggestedCount: 0,
      suggestedWhy: "",
    });
    expect(empty).toBeNull();
  });
});

describe("what a store can't save as wording", () => {
  it("a placeholder this email doesn't have, naming the ones it does", () => {
    const problem = emailWordingProblem("invoice", { intro: "Hi {nope}" });
    expect(problem).toMatch(/\{nope\}/);
    expect(problem).toMatch(/customer, invoice, total, store/);
  });
  it("a placeholder from another email", () => {
    expect(emailWordingProblem("low-stock", { closing: "{invoice}" })).not.toBeNull();
  });
  it("an empty subject", () => {
    expect(emailWordingProblem("invoice", { subject: "  " })).toMatch(/subject/);
  });
  it("text too long", () => {
    expect(
      emailWordingProblem("invoice", { intro: "x".repeat(EMAIL_WORDING_MAX + 1) }),
    ).not.toBeNull();
    expect(emailWordingProblem("invoice", { intro: "x".repeat(EMAIL_WORDING_MAX) })).toBeNull();
    expect(
      emailWordingProblem("invoice", { subject: "x".repeat(EMAIL_SUBJECT_MAX + 1) }),
    ).not.toBeNull();
    expect(emailWordingProblem("invoice", { subject: "x".repeat(EMAIL_SUBJECT_MAX) })).toBeNull();
  });
  it("takes nothing changed", () => {
    expect(emailWordingProblem("invoice", {})).toBeNull();
    expect(emailWordingProblem("invoice", { subject: null, intro: null })).toBeNull();
  });
  it("knows its own emails", () => {
    expect(isEmailKind("invoice")).toBe(true);
    expect(isEmailKind("nope")).toBe(false);
  });
});

describe("the look's pieces", () => {
  it("takes only a plain six-digit colour", () => {
    expect(isEmailColor("#7a3e1d")).toBe(true);
    for (const bad of ["red", "#fff", "#7a3e1", "#7a3e1dd", '#000";x:"', null, 5]) {
      expect(isEmailColor(bad)).toBe(false);
    }
  });
  it("keeps a button readable", () => {
    expect(textOn("#ffffff")).toBe("#14161f");
    expect(textOn("#ffe680")).toBe("#14161f");
    expect(textOn("#000000")).toBe("#f5f4f0");
    expect(textOn(DEFAULT_EMAIL_ACCENT)).toBe("#f5f4f0");
  });
  it("makes a logo's address one a mail client can load", () => {
    const base = "https://store.example.com/";
    expect(absoluteLogoUrl("/uploads/logo.png", base)).toBe(
      "https://store.example.com/uploads/logo.png",
    );
    expect(absoluteLogoUrl("https://cdn.example.com/l.png", base)).toBe(
      "https://cdn.example.com/l.png",
    );
    for (const bad of [
      null,
      "",
      "javascript:alert(1)",
      "data:image/png;base64,AA",
      "//evil/x",
      "logo.png",
    ]) {
      expect(absoluteLogoUrl(bad, base)).toBeNull();
    }
  });
  it("reads a store's settings, falling back when one isn't usable", () => {
    const app = {
      emailAccentColor: "#7a3e1d",
      emailShowLogo: true,
      emailFooter: " Hi ",
      logoUrl: "/l.png",
    };
    expect(readEmailLook(app, "https://s.example.com")).toEqual({
      accent: "#7a3e1d",
      logoUrl: "https://s.example.com/l.png",
      footer: "Hi",
    });
    expect(
      readEmailLook(
        { emailAccentColor: "red", emailShowLogo: false, emailFooter: "  ", logoUrl: "/l.png" },
        "https://s.example.com",
      ),
    ).toEqual(DEFAULT_EMAIL_LOOK);
  });
});

// /app/__tests__/followUpEmailTemplate.test.ts
//
// What the morning email says (GAP-36). Client names and notes are typed by people, so they
// have to arrive as text.

import {
  FOLLOW_UP_EMAIL_MAX_DUE,
  followUpEmail,
  type FollowUpEmailInput,
  DEFAULT_EMAIL_CHROME,
} from "@/lib/email/templates";

function input(over: Partial<FollowUpEmailInput> = {}): FollowUpEmailInput {
  return {
    storeName: "Test Store",
    staffName: "Pat Lund",
    baseUrl: "https://store.example.com",
    due: [],
    quotesWaiting: 0,
    suggested: [],
    suggestedCount: 0,
    suggestedWhy: "Past clients who've gone quiet.",
    chrome: DEFAULT_EMAIL_CHROME,
    ...over,
  };
}
const client = (name: string) => ({ name, detail: "due Nov 5" });

describe("followUpEmail", () => {
  it("sends nothing when there's nothing to say", () => {
    expect(followUpEmail(input())).toBeNull();
  });

  it("names everything in the subject, in the plural it needs", () => {
    const email = followUpEmail(
      input({
        due: [client("Nora Vale"), client("Otto Rand")],
        quotesWaiting: 1,
        suggested: [client("Una Pike")],
        suggestedCount: 3,
      }),
    );
    expect(email?.subject).toBe("Your follow-ups: 2 due, 1 quote waiting, 3 past clients to call");
    expect(followUpEmail(input({ quotesWaiting: 2 }))?.subject).toBe(
      "Your follow-ups: 2 quotes waiting",
    );
    expect(followUpEmail(input({ suggestedCount: 1 }))?.subject).toBe(
      "Your follow-ups: 1 past client to call",
    );
  });

  it("greets them and links to each list under the /app paths", () => {
    const html =
      followUpEmail(
        input({
          due: [client("Nora Vale")],
          quotesWaiting: 1,
          suggested: [client("Una Pike")],
          suggestedCount: 1,
        }),
      )?.html ?? "";
    expect(html).toContain("Good morning Pat Lund,");
    expect(html).toContain("Follow-ups due (1)");
    expect(html).toContain("https://store.example.com/app/sales/clients?show=due");
    expect(html).toContain("Open quotes waiting on you (1)");
    expect(html).toContain("https://store.example.com/app/sales/pipeline");
    expect(html).toContain("Past clients worth a call (1)");
    expect(html).toContain("who&#39;ve gone quiet");
    expect(html).toContain("https://store.example.com/app/sales/clients?show=suggested");
  });

  it("leaves out a section with nothing in it", () => {
    const html = followUpEmail(input({ quotesWaiting: 1 }))?.html ?? "";
    expect(html).not.toContain("Follow-ups due");
    expect(html).not.toContain("Past clients worth a call");
    const onlyDue = followUpEmail(input({ due: [client("Nora Vale")] }))?.html ?? "";
    expect(onlyDue).not.toContain("Open quotes waiting");
  });

  it("lists up to the limit and says how many more", () => {
    const due = Array.from({ length: FOLLOW_UP_EMAIL_MAX_DUE + 2 }, (_, i) =>
      client(`Client ${i}`),
    );
    const html = followUpEmail(input({ due }))?.html ?? "";
    expect(html).toContain(`Client ${FOLLOW_UP_EMAIL_MAX_DUE - 1}<`);
    expect(html).not.toContain(`Client ${FOLLOW_UP_EMAIL_MAX_DUE}<`);
    expect(html).toContain("And 2 more.");
    const exact = due.slice(0, FOLLOW_UP_EMAIL_MAX_DUE);
    expect(followUpEmail(input({ due: exact }))?.html).not.toContain("more.");
  });

  it("escapes what people typed", () => {
    const html =
      followUpEmail(
        input({
          staffName: "<b>Pat</b>",
          due: [{ name: "<img src=x>", detail: "last note: <script>bad()</script>" }],
        }),
      )?.html ?? "";
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Pat</b>");
    expect(html).toContain("&lt;img src=x&gt;");
  });
});

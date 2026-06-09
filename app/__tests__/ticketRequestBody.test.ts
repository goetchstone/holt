// /app/__tests__/ticketRequestBody.test.ts

import {
  parseTicketCreateInput,
  parseTicketUpdateInput,
  parseTicketMessageInput,
} from "@/lib/tickets/requestBody";

describe("parseTicketCreateInput", () => {
  it("accepts a valid public submission and trims fields", () => {
    const out = parseTicketCreateInput({
      submitterName: "  Dana Lee  ",
      submitterEmail: "dana@example.com",
      subject: "  Chair wobbles  ",
      body: "The left leg is loose.",
    });
    expect(out.submitterName).toBe("Dana Lee");
    expect(out.subject).toBe("Chair wobbles");
    expect(out.priority).toBeUndefined();
  });

  it("rejects a missing or invalid email", () => {
    expect(() => parseTicketCreateInput({ submitterName: "A", subject: "S", body: "B" })).toThrow();
    expect(() =>
      parseTicketCreateInput({
        submitterName: "A",
        submitterEmail: "not-an-email",
        subject: "S",
        body: "B",
      }),
    ).toThrow("Enter a valid email");
  });

  it("rejects an empty subject", () => {
    expect(() =>
      parseTicketCreateInput({
        submitterName: "A",
        submitterEmail: "a@b.com",
        subject: "   ",
        body: "B",
      }),
    ).toThrow("A subject is required");
  });

  it("rejects an unknown priority", () => {
    expect(() =>
      parseTicketCreateInput({
        submitterName: "A",
        submitterEmail: "a@b.com",
        subject: "S",
        body: "B",
        priority: "WHENEVER",
      }),
    ).toThrow();
  });
});

describe("parseTicketUpdateInput", () => {
  it("accepts a single triage field", () => {
    expect(parseTicketUpdateInput({ status: "RESOLVED" })).toEqual({ status: "RESOLVED" });
    expect(parseTicketUpdateInput({ assignedToId: null })).toEqual({ assignedToId: null });
  });

  it("rejects an empty update", () => {
    expect(() => parseTicketUpdateInput({})).toThrow("Nothing to update");
  });

  it("rejects a non-positive assignee id and a bad status", () => {
    expect(() => parseTicketUpdateInput({ assignedToId: -1 })).toThrow();
    expect(() => parseTicketUpdateInput({ status: "NOPE" })).toThrow();
  });
});

describe("parseTicketMessageInput", () => {
  it("accepts a body and optional internal flag", () => {
    expect(parseTicketMessageInput({ body: "On it." })).toEqual({ body: "On it." });
    expect(parseTicketMessageInput({ body: "note", isInternal: true })).toEqual({
      body: "note",
      isInternal: true,
    });
  });

  it("rejects an empty body", () => {
    expect(() => parseTicketMessageInput({ body: "   " })).toThrow("Message cannot be empty");
  });
});

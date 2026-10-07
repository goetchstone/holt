// /app/__tests__/mailchimpAudienceSync.test.ts
//
// Pure-helper tests for the customer-audience sync runner. The runner
// itself talks to live Mailchimp + Postgres so it lives outside the unit
// project; the helpers here are deterministic and tested in isolation.

import {
  subscriberHash,
  buildMemberPayload,
  describeSyncError,
  AUDIENCE_TAG_NEW_CUSTOMER,
} from "@/lib/mailchimpAudienceSync";
import axios from "axios";

describe("subscriberHash", () => {
  test("returns md5 of the lowercased email -- Mailchimp's required format", () => {
    // Reference value from Mailchimp's own docs example:
    //   "urist.mcvankab@freddiesjokes.com" -> "62eeb292278cc15f5817cb78f7790b08"
    expect(subscriberHash("urist.mcvankab@freddiesjokes.com")).toBe(
      "62eeb292278cc15f5817cb78f7790b08",
    );
  });

  test("normalizes case so two casings hash identically", () => {
    const a = subscriberHash("Goetch@example.com");
    const b = subscriberHash("goetch@example.com");
    expect(a).toBe(b);
  });

  test("trims surrounding whitespace before hashing", () => {
    expect(subscriberHash("  jane@doe.com  ")).toBe(subscriberHash("jane@doe.com"));
  });
});

describe("buildMemberPayload", () => {
  test("returns null for empty / whitespace-only email", () => {
    expect(buildMemberPayload({ email: "", firstName: null, lastName: null })).toBeNull();
    expect(buildMemberPayload({ email: "   ", firstName: null, lastName: null })).toBeNull();
  });

  test("returns null for malformed email (skips silently rather than 400)", () => {
    expect(
      buildMemberPayload({ email: "not-an-email", firstName: null, lastName: null }),
    ).toBeNull();
    expect(buildMemberPayload({ email: "@nodomain", firstName: null, lastName: null })).toBeNull();
    expect(
      buildMemberPayload({ email: "no-at-sign.com", firstName: null, lastName: null }),
    ).toBeNull();
  });

  test("builds a pending double-opt-in payload for a valid customer", () => {
    const payload = buildMemberPayload({
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Walker",
    });
    expect(payload).not.toBeNull();
    expect(payload!.email_address).toBe("alice@example.com");
    // status_if_new is the key -- existing subscribed members keep their
    // status, only new contacts get the double opt-in flow.
    expect(payload!.status_if_new).toBe("pending");
    expect(payload!.merge_fields).toEqual({ FNAME: "Alice", LNAME: "Walker" });
    expect(payload!.tags).toContain(AUDIENCE_TAG_NEW_CUSTOMER);
  });

  test("omits merge fields when the customer has no first/last name", () => {
    const payload = buildMemberPayload({
      email: "anon@example.com",
      firstName: null,
      lastName: null,
    });
    expect(payload).not.toBeNull();
    expect(payload!.merge_fields).toEqual({});
  });

  test("includes only the populated merge field when one of two is set", () => {
    const payload = buildMemberPayload({
      email: "first-only@example.com",
      firstName: "Cher",
      lastName: null,
    });
    expect(payload!.merge_fields).toEqual({ FNAME: "Cher" });
    expect(payload!.merge_fields.LNAME).toBeUndefined();
  });

  test("trims whitespace on first/last name before assigning", () => {
    const payload = buildMemberPayload({
      email: "trim@example.com",
      firstName: "  Joe  ",
      lastName: "  Smith  ",
    });
    expect(payload!.merge_fields.FNAME).toBe("Joe");
    expect(payload!.merge_fields.LNAME).toBe("Smith");
  });

  test("preserves email case in payload but normalizes for hash (caller's job)", () => {
    // The payload sends the original-case email so Mailchimp displays it
    // as the user typed it. The subscriber_hash path segment is what
    // needs to be lowercased -- that's done by subscriberHash() at the
    // call site, not here.
    const payload = buildMemberPayload({
      email: "Mixed.Case@Example.com",
      firstName: null,
      lastName: null,
    });
    expect(payload!.email_address).toBe("Mixed.Case@Example.com");
  });
});

describe("describeSyncError", () => {
  test("returns Mailchimp API response detail for axios errors with response.data", () => {
    const axiosErr = {
      isAxiosError: true,
      response: { data: { detail: "Member exists", status: 400 } },
    };
    // Use the real axios.isAxiosError to verify the function recognizes
    // the error shape. Because we want to mock the type-guard reliably,
    // mark the prop directly and rely on `isAxiosError`'s shape check.
    const original = axios.isAxiosError;
    (axios as { isAxiosError: (e: unknown) => boolean }).isAxiosError = (e) =>
      typeof e === "object" && e !== null && "isAxiosError" in (e as object);
    try {
      const msg = describeSyncError(axiosErr);
      expect(msg).toContain("Member exists");
      expect(msg).toContain("400");
    } finally {
      (axios as { isAxiosError: typeof original }).isAxiosError = original;
    }
  });

  test("truncates long axios error bodies to 300 chars", () => {
    const axiosErr = {
      isAxiosError: true,
      response: { data: { detail: "x".repeat(1000) } },
    };
    const original = axios.isAxiosError;
    (axios as { isAxiosError: (e: unknown) => boolean }).isAxiosError = (e) =>
      typeof e === "object" && e !== null && "isAxiosError" in (e as object);
    try {
      const msg = describeSyncError(axiosErr);
      expect(msg.length).toBeLessThanOrEqual(300);
    } finally {
      (axios as { isAxiosError: typeof original }).isAxiosError = original;
    }
  });

  test("returns Error.message for plain Error instances", () => {
    expect(describeSyncError(new Error("network down"))).toBe("network down");
  });

  test("returns 'unknown error' for non-Error non-axios throws", () => {
    expect(describeSyncError("just a string")).toBe("unknown error");
    expect(describeSyncError(42)).toBe("unknown error");
    expect(describeSyncError(null)).toBe("unknown error");
    expect(describeSyncError(undefined)).toBe("unknown error");
    expect(describeSyncError({ random: "object" })).toBe("unknown error");
  });
});

describe("Tripwire: pending double opt-in is the only allowed default", () => {
  // CLAUDE.md rule 48: every config-relevant choice gets a tripwire.
  // The user's stated requirement was "should be pending we always do
  // double opt in" -- if someone changes status_if_new to "subscribed"
  // they bypass that consent flow, which would be a real GDPR/CAN-SPAM
  // problem in addition to a business decision change.
  test("payload always uses status_if_new: pending", () => {
    const payload = buildMemberPayload({
      email: "anyone@example.com",
      firstName: "X",
      lastName: "Y",
    });
    expect(payload!.status_if_new).toBe("pending");
  });
});

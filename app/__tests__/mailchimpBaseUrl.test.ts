// /app/__tests__/mailchimpBaseUrl.test.ts

import { mailchimpDatacenter, mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";

describe("mailchimp datacenter validation", () => {
  it("extracts a well-formed datacenter suffix", () => {
    expect(mailchimpDatacenter("abc123def456-us21")).toBe("us21");
    expect(mailchimpDatacenter("key-us6")).toBe("us6");
  });

  it("rejects a missing key", () => {
    expect(mailchimpDatacenter(undefined)).toBeNull();
    expect(mailchimpDatacenter(null)).toBeNull();
    expect(mailchimpDatacenter("")).toBeNull();
  });

  it("rejects a key with no datacenter suffix", () => {
    expect(mailchimpDatacenter("just-")).toBeNull();
    expect(mailchimpDatacenter("nodash")).toBeNull();
  });

  it("rejects an SSRF-shaped suffix so it can't repoint the host", () => {
    expect(mailchimpDatacenter("key-evil.example.com/")).toBeNull();
    expect(mailchimpDatacenter("key-us21/../admin")).toBeNull();
    expect(mailchimpDatacenter("key-localhost")).toBeNull();
  });

  it("builds the canonical REST host from a validated datacenter", () => {
    expect(mailchimpBaseUrl("us21")).toBe("https://us21.api.mailchimp.com/3.0");
  });
});

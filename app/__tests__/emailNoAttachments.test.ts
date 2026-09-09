// /app/__tests__/emailNoAttachments.test.ts
//
// The nodemailer advisory GHSA-8m3c-c648-2xjj is suppressed in
// `audit-allowlist.json` on one claim: Holt never sends attachments, so
// resolveContent()'s disableFileAccess bypass is unreachable here.
//
// This test is what makes that claim checkable rather than a promise. A
// suppression whose reason nobody verifies is a decision made once and
// inherited forever -- and the reason here would stop being true the moment
// someone adds a PDF to an email, which is an ordinary thing to want.
//
// If this fails, the suppression is void: remove it and take the nodemailer
// major, rather than editing this test to pass.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SENDER = join(__dirname, "..", "src", "lib", "email", "sender.ts");

describe("the email sender passes no attachments", () => {
  it("never hands nodemailer an attachments option", () => {
    const src = readFileSync(SENDER, "utf8");
    // Matches `attachments:` as an object key, which is the only way the
    // vulnerable path is reached. Comments mentioning the word are fine.
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\battachments\s*:/);
  });

  it("still routes through sendMail, so this file is the right thing to check", () => {
    // A guard on a file nothing calls is no guard. If sending moves, this
    // fails and points at the fact that the suppression's evidence moved too.
    expect(readFileSync(SENDER, "utf8")).toMatch(/sendMail\s*\(/);
  });

  // Both directions: the allowlist entry must actually name this file, so a
  // future reader of the suppression lands on the check that backs it.
  it("is the evidence the allowlist cites", () => {
    const allow = JSON.parse(
      readFileSync(join(__dirname, "..", "audit-allowlist.json"), "utf8"),
    ) as { allow: { id: string; reason: string; expires: string }[] };
    const entry = allow.allow.find((a) => a.id === "GHSA-8m3c-c648-2xjj");
    expect(entry).toBeDefined();
    expect(entry!.reason).toContain("emailNoAttachments.test.ts");
    // An expiry in the past means the gate is already failing; catch it here too.
    expect(new Date(entry!.expires).getTime()).toBeGreaterThan(Date.now());
  });
});

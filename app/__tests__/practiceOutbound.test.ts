// __tests__/practiceOutbound.test.ts
//
// Everything on the server that can reach outside Holt, and what stops it on a
// practice copy (GAP-28, rule 65). A new integration fails this until someone decides
// how it behaves there, which is the point: the one nobody listed is the one that
// charges a real card from a practice sale. A source-text tripwire on purpose (rule
// 57): the set is what's checked here. What each guard actually does is exercised in
// __tests__/integration/practiceCopy.integration.test.ts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

type Stopped =
  /** Every key it uses comes from resolveCredential, which is empty on a practice copy. */
  | { by: "credentials" }
  /** Its host comes from mailchimpBaseUrl, which goes nowhere on a practice copy. */
  | { by: "mailchimpBaseUrl" }
  /** It asks isPracticeCopy itself. */
  | { by: "own check" }
  /** It only talks through another module listed here. */
  | { by: "through"; module: string }
  /** It's meant to keep working. */
  | { by: "allowed"; reason: string };

const OUTBOUND: Record<string, Stopped> = {
  "src/lib/square.ts": { by: "credentials" },
  "src/lib/sms/twilio.ts": { by: "credentials" },
  "src/lib/stripe.ts": { by: "credentials" },
  "src/lib/payments/stripeProvider.ts": { by: "through", module: "@/lib/stripe" },
  "src/lib/email/sender.ts": { by: "through", module: "./config" },
  "src/lib/githubApp.ts": { by: "credentials" },
  "src/pages/api/notifications/issues.ts": { by: "through", module: "@/lib/githubApp" },
  "src/lib/axperClient.ts": { by: "credentials" },
  "src/lib/adapters/ordorite/gmailClient.ts": { by: "credentials" },
  "src/lib/mailchimpSyncRunners.ts": { by: "credentials" },
  "src/lib/mailchimpAudienceSync.ts": { by: "credentials" },
  "src/lib/integrationTest.ts": { by: "credentials" },
  "src/pages/api/mailchimp/sync.ts": { by: "mailchimpBaseUrl" },
  "src/pages/api/mailchimp/sync-metrics.ts": { by: "mailchimpBaseUrl" },
  "src/pages/api/mailchimp/sync-activity.ts": { by: "mailchimpBaseUrl" },
  "src/pages/api/mailchimp/sync-all-activity.ts": { by: "mailchimpBaseUrl" },
  "src/pages/api/mailchimp/campaigns/index.ts": { by: "mailchimpBaseUrl" },
  "src/lib/opsAlert.ts": { by: "own check" },
  "src/pages/api/google/create-project.ts": { by: "own check" },
  "src/lib/labelPrinter.ts": {
    by: "allowed",
    reason:
      "Prints paper on a printer the store set up on its own network. Tags are part of what staff practise, and nothing leaves the building.",
  },
};

/** Marks a file as able to reach outside. Client code only reaches its own server. */
const OUTBOUND_MARKER =
  /\bfetch\(|from ["'](axios|nodemailer|stripe|net|node:net|tls|node:tls|http|node:http|https|node:https|googleapis|google-auth-library)["']|new Stripe\(/;

const APP_ROOT = path.resolve(__dirname, "..");

function serverFiles(): string[] {
  const listed = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "src/lib",
      "src/pages/api",
      "src/app/api",
      "src/server",
    ],
    { cwd: APP_ROOT, encoding: "utf8" },
  );
  return listed
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !f.startsWith("src/lib/hooks/")) // client hooks, calling their own server
    .filter((f) => f !== "src/lib/toastError.ts"); // reads axios's error type, never calls it
}

function source(file: string): string {
  return readFileSync(path.join(APP_ROOT, file), "utf8");
}

function withoutComments(text: string): string {
  // Line comments first: "/api/mailchimp/*" in one would otherwise open a block.
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("what can reach outside Holt, and what stops it on a practice copy", () => {
  const reaching = serverFiles().filter((f) => OUTBOUND_MARKER.test(withoutComments(source(f))));

  it("lists everything that can", () => {
    const unlisted = reaching.filter((f) => !(f in OUTBOUND));
    expect(unlisted).toEqual([]);
  });

  it("lists nothing that can't", () => {
    const stale = Object.keys(OUTBOUND).filter((f) => !reaching.includes(f));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(OUTBOUND))("%s is stopped the way it says", (file, stopped) => {
    const text = withoutComments(source(file));
    switch (stopped.by) {
      case "credentials":
        expect(text).toContain("resolveCredential(");
        break;
      case "mailchimpBaseUrl":
        expect(text).toContain("mailchimpBaseUrl(");
        break;
      case "own check":
        expect(text).toContain("isPracticeCopy()");
        break;
      case "through":
        expect(text).toContain(`"${stopped.module}"`);
        break;
      case "allowed":
        expect(stopped.reason.length).toBeGreaterThan(20);
        break;
    }
  });
});

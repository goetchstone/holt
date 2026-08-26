// /app/__tests__/opsAlertLoop.test.ts
//
// The alert path must never produce an error worth alerting about.
//
// It did. logError() records an ErrorEvent; recordError() calls reportOpsAlert
// the first time it sees a fingerprint; reportOpsAlert logged itself through
// logError. So every alert became a NEW message -- "ops-alert: " prepended to
// the previous title -- which is a new fingerprint, which is a first sighting,
// which alerts again. Unbounded, and growing by one prefix per pass:
//
//   ops-alert: New error: ops-alert: New error: ops-alert: New error: ...
//
// One missing API key was enough to start it. It produced 1,154 ErrorEvent rows
// of the loop's own output and a server too busy to answer a login -- and it
// made the error log useless at exactly the moment somebody would go looking.
//
// Two guards, tested here as source-text because the runtime path needs Prisma
// and the point is structural: the shape must not come back.

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Source with comment lines removed.
 *
 * The header of opsAlert.ts explains the loop at length and names logError
 * several times doing it. Matching those would make this test fail on its own
 * documentation, so strip whole comment lines first -- the same approach
 * dbGuardsCoverage.test.ts takes for the same reason.
 */
function codeOf(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const opsAlert = codeOf(readFileSync(path.join(__dirname, "../src/lib/opsAlert.ts"), "utf8"));
const recorder = readFileSync(path.join(__dirname, "../src/lib/errorRecorder.ts"), "utf8");

describe("the ops-alert path cannot feed itself", () => {
  it("opsAlert.ts never calls logError", () => {
    // logger.error writes to stdout and stops. logError records, and recording
    // is what calls back into here.
    const calls = opsAlert.match(/\blogError\s*\(/g) ?? [];
    expect(calls).toEqual([]);
  });

  it("opsAlert.ts does not import logError", () => {
    expect(opsAlert).not.toMatch(
      /import\s*\{[^}]*\blogError\b[^}]*\}\s*from\s*["']@\/lib\/logger["']/,
    );
  });

  it("the recorder guards against re-entering the alert path", () => {
    // Belt and braces: even if some future caller reintroduces a logError on
    // the alert path, this stops the second lap.
    expect(recorder).toMatch(/if\s*\(alerting\)\s*return;/);
    expect(recorder).toMatch(/alerting\s*=\s*true;/);
    expect(recorder).toMatch(/finally\s*\{[\s\S]{0,80}alerting\s*=\s*false;/);
  });

  it("still alerts -- the guard did not simply switch alerting off", () => {
    // The cheapest wrong fix would be to stop calling reportOpsAlert at all,
    // which would make this file pass and lose the alerting.
    expect(recorder).toMatch(/await\s+reportOpsAlert\(/);
    expect(recorder).toMatch(/ALERT_AT_COUNTS/);
  });
});

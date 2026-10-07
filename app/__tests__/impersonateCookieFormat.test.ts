// /app/__tests__/impersonateCookieFormat.test.ts
//
// Tripwire for the 2026-04-30 impersonation lockout bug.
//
// Symptom: ADMIN clicked "Stop Impersonating" → button did nothing → user
// was stuck. Root cause: the Set-Cookie header in `pages/api/admin/
// impersonate.ts` assembled `...; SameSite=Lax Max-Age=14400` (no
// semicolon between SameSite and Max-Age). Browsers parsed
// `SameSite=Lax Max-Age=14400` as one malformed attribute, so Max-Age
// got swallowed. On the clear path, Max-Age=0 was likewise dropped:
// the cookie's value was reset to "" but the cookie itself persisted.
// `useEffectiveRole` then returned "" for impersonatedRole, treated it
// as truthy (string !== null), and reported isImpersonating=true,
// trapping the user.
//
// This test reads the source file and asserts the canonical fix:
// attributes are assembled via array+join, never raw template
// concatenation, so the missing-semicolon shape can't reappear.
//
// Source-text tripwire (B- per Phase 0.6 grading) — picks up an
// accidental refactor back to the broken shape. Real-DB integration
// would be A-grade but isn't worth the harness cost for a route this
// narrow; the source-text scan is sufficient for the "developer
// reverts the fix by accident" failure mode.

import { readFileSync } from "fs";
import { join } from "path";

// Strip line comments before scanning so the documented "this used to
// say `SameSite=Lax Max-Age=` and that's why we changed it" comment
// doesn't trip the bad-pattern test.
function readSourceWithoutComments(...parts: string[]): string {
  const raw = readFileSync(join(__dirname, ...parts), "utf8");
  return raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

const SOURCE = readSourceWithoutComments("..", "src", "pages", "api", "admin", "impersonate.ts");

describe("impersonate.ts cookie-format guard (2026-04-30 regression test)", () => {
  it("assembles cookie attributes with explicit semicolon-space joining, never raw concat", () => {
    // The fixed shape uses ["Path=/", "SameSite=Lax", ...].join("; ")
    // (or equivalent). This ensures every attribute boundary has a
    // semicolon, regardless of which optional attributes are present.
    expect(SOURCE).toMatch(/\.join\("; "\)/);
  });

  it("does not contain the broken pattern '`SameSite=Lax Max-Age=`' (no semicolon)", () => {
    // The pre-fix shape interpolated `${baseAttrs} Max-Age=14400` where
    // baseAttrs ended in `SameSite=Lax`. That produced
    // `SameSite=Lax Max-Age=14400` (one space, no semicolon).
    expect(SOURCE).not.toMatch(/SameSite=Lax Max-Age=/);
    expect(SOURCE).not.toMatch(/SameSite=Lax\}\s*Max-Age=/);
  });

  it("clear path emits Max-Age=0", () => {
    // The clear branch must explicitly set Max-Age=0 so the cookie
    // expires. Resetting only the value to empty (without Max-Age)
    // leaves the cookie present-with-empty-value, which the client
    // hook used to treat as still-impersonating.
    expect(SOURCE).toMatch(/Max-Age=0/);
  });

  it("set path emits Max-Age=14400 (4-hour expiry per docs)", () => {
    expect(SOURCE).toMatch(/Max-Age=14400/);
  });
});

describe("useEffectiveRole.ts empty-cookie-value guard (2026-04-30 regression test)", () => {
  const HOOK_SOURCE = readSourceWithoutComments("..", "src", "lib", "hooks", "useEffectiveRole.ts");

  it("treats empty cookie value as null (not as 'still impersonating')", () => {
    // The fix: getCookie returns null for a present-but-empty cookie.
    // Before the fix, `decodeURIComponent("")` returned `""`, and
    // `isImpersonating = realRole === "ADMIN" && impersonatedRole !== null`
    // was true because "" !== null.
    expect(HOOK_SOURCE).toMatch(/value === ""/);
    expect(HOOK_SOURCE).toMatch(/value === "" \? null/);
  });
});

describe("ImpersonationBanner is wired into _app.tsx (global escape hatch)", () => {
  const APP_SOURCE = readSourceWithoutComments("..", "src", "pages", "_app.tsx");

  it("imports ImpersonationBanner", () => {
    expect(APP_SOURCE).toMatch(/import ImpersonationBanner from/);
  });

  it("renders <ImpersonationBanner /> inside the app tree", () => {
    expect(APP_SOURCE).toMatch(/<ImpersonationBanner \/>/);
  });
});

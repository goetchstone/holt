// /app/__tests__/safeCallbackUrl.test.ts
//
// The login page's ?callbackUrl= is attacker-craftable, and it reaches
// router.push() and NextAuth's `window.location.href = callbackUrl` fallback.
// CodeQL js/xss #6 and js/client-side-unvalidated-url-redirection #9. Each
// hostile case below was accepted verbatim before safeCallbackUrl existed.

import { DEFAULT_CALLBACK_PATH, safeCallbackUrl } from "@/lib/auth/safeCallbackUrl";

const ORIGIN = "https://holt.example.com";
const HOME = `${ORIGIN}${DEFAULT_CALLBACK_PATH}`;

describe("safeCallbackUrl", () => {
  it("keeps a same-origin path, with its query and fragment", () => {
    expect(safeCallbackUrl("/app/sales/orders?status=OPEN#top", ORIGIN)).toBe(
      `${ORIGIN}/app/sales/orders?status=OPEN#top`,
    );
  });

  it("keeps a same-origin absolute URL, which is what NextAuth itself sends", () => {
    expect(safeCallbackUrl(`${ORIGIN}/app/inventory`, ORIGIN)).toBe(`${ORIGIN}/app/inventory`);
  });

  it("falls back to the app home when there is no usable value", () => {
    expect(safeCallbackUrl(undefined, ORIGIN)).toBe(HOME);
    expect(safeCallbackUrl("", ORIGIN)).toBe(HOME);
    // A repeated parameter arrives as an array; neither element is trusted.
    expect(safeCallbackUrl(["/app/x", "https://evil.example"], ORIGIN)).toBe(HOME);
  });

  it.each([
    ["another origin", "https://evil.example/login"],
    ["a protocol-relative URL", "//evil.example/login"],
    ["a backslash the URL parser reads as a slash", "/\\evil.example/login"],
    ["a tab the URL parser strips", "/\t/evil.example/login"],
    ["userinfo that moves the host", `${ORIGIN}@evil.example/`],
    ["a different scheme on our host", "http://holt.example.com/app"],
    ["a javascript: URL", "javascript:alert(document.cookie)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
  ])("refuses %s", (_label, hostile) => {
    expect(safeCallbackUrl(hostile, ORIGIN)).toBe(HOME);
  });

  it("keeps a path the parser normalises to //host on OUR host, not as protocol-relative", () => {
    // new URL("/.//evil.example", origin).pathname is "//evil.example". Handed
    // back bare, the browser would read it as a different host.
    const result = safeCallbackUrl("/.//evil.example/x", ORIGIN);
    expect(new URL(result).origin).toBe(ORIGIN);
    expect(result.startsWith(`${ORIGIN}/`)).toBe(true);
  });
});

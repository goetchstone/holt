// /app/__tests__/contentSecurityPolicy.test.ts
//
// The page policy src/proxy.ts sends (lib/contentSecurityPolicy.ts). What it
// must keep true: no unsafe keyword for scripts in production; a nonce Next
// can read back, since Next silently ignores one it can't and every script on
// the page is then blocked; no nonce in style-src, which would switch
// 'unsafe-inline' off and unstyle the app; and frames from the same embed
// providers the CMS sanitizer admits. The browser sweep (e2e/pages.spec.ts)
// checks the header each page actually answers with.

import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { CMS_EMBED_HOSTNAMES } from "@/lib/cms/embedHosts";
import { contentSecurityPolicy, newNonce } from "@/lib/contentSecurityPolicy";

/** Each directive's sources, by directive name. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  );
}

const NONCE = newNonce();
const production = directives(contentSecurityPolicy(NONCE, false));
const development = directives(contentSecurityPolicy(NONCE, true));

describe("contentSecurityPolicy", () => {
  it("runs scripts by nonce in production, with no unsafe keyword", () => {
    const script = production.get("script-src");
    expect(script).toEqual(expect.arrayContaining([`'nonce-${NONCE}'`, "'strict-dynamic'"]));
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("adds only 'unsafe-eval' in development", () => {
    const added: string[] = [];
    const removed: string[] = [];
    for (const name of new Set([...production.keys(), ...development.keys()])) {
      const prod = production.get(name) ?? [];
      const dev = development.get(name) ?? [];
      added.push(...dev.filter((s) => !prod.includes(s)).map((s) => `${name} ${s}`));
      removed.push(...prod.filter((s) => !dev.includes(s)).map((s) => `${name} ${s}`));
    }
    expect(added).toEqual(["script-src 'unsafe-eval'"]);
    expect(removed).toEqual([]);
  });

  it("carries a nonce Next reads back, the way it reads it when rendering", () => {
    const nonce = newNonce();
    expect(getScriptNonceFromHeader(contentSecurityPolicy(nonce, false))).toBe(nonce);
  });

  it("mints a different nonce each time", () => {
    expect(newNonce()).not.toBe(newNonce());
  });

  it("allows inline styles and gives style-src no nonce, which would switch that off", () => {
    const style = production.get("style-src") ?? [];
    expect(style).toContain("'unsafe-inline'");
    expect(style.filter((s) => s.startsWith("'nonce-"))).toEqual([]);
  });

  it("keeps plugins, <base>, form targets and framing locked down", () => {
    expect(production.get("object-src")).toEqual(["'none'"]);
    expect(production.get("base-uri")).toEqual(["'self'"]);
    expect(production.get("form-action")).toEqual(["'self'"]);
    expect(production.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("frames every CMS embed provider the sanitizer admits", () => {
    const frames = production.get("frame-src") ?? [];
    expect(CMS_EMBED_HOSTNAMES.filter((host) => !frames.includes(`https://${host}`))).toEqual([]);
  });
});

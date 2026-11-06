// __tests__/practiceBanner.test.ts
//
// The banner reaches both routers' outermost documents (GAP-28). Rendered for real
// only in a browser check, since those documents need a server; here, what each
// document returns decides whether the banner is in it.

jest.mock("@/lib/appSettings", () => ({
  getAppSettings: jest.fn().mockResolvedValue({ theme: null, faviconUrl: null }),
  getPublicBranding: jest.fn().mockResolvedValue({ appName: "Test" }),
  themeToCssVars: jest.fn().mockReturnValue(""),
}));
jest.mock("@/styles/globals.css", () => ({}), { virtual: true });
jest.mock("@/app/providers", () => ({ Providers: () => null }));
jest.mock("next/document", () => ({
  Html: () => null,
  Head: () => null,
  Main: () => null,
  NextScript: () => null,
}));

import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout, { dynamic } from "@/app/layout";
import Document from "@/pages/_document";
import { PracticeBanner } from "@/components/PracticeBanner";

const realUrl = process.env.DATABASE_URL;
afterEach(() => {
  process.env.DATABASE_URL = realUrl;
});

function hasBanner(node: ReactNode): boolean {
  return Children.toArray(node).some(
    (child) =>
      isValidElement<{ children?: ReactNode }>(child) &&
      (child.type === PracticeBanner || hasBanner(child.props.children)),
  );
}

const PRACTICE = "postgresql://u:p@db:5432/holt_demo_practice";
const LIVE = "postgresql://u:p@db:5432/holt";

describe("App Router: every screen goes through the root layout", () => {
  it("renders per request, so a page built ahead of time can't miss the banner", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  it("shows the banner on a practice copy", async () => {
    process.env.DATABASE_URL = PRACTICE;
    expect(hasBanner(await RootLayout({ children: null }))).toBe(true);
  });
  it("and not otherwise", async () => {
    process.env.DATABASE_URL = LIVE;
    expect(hasBanner(await RootLayout({ children: null }))).toBe(false);
  });
});

describe("Pages Router: the sign-in screens go through _document", () => {
  const initial = () =>
    (
      Document as unknown as {
        getInitialProps: (ctx: unknown) => Promise<{ practice: boolean }>;
      }
    ).getInitialProps({ defaultGetInitialProps: async () => ({ html: "" }) });

  it("shows the banner on a practice copy", async () => {
    process.env.DATABASE_URL = PRACTICE;
    const props = await initial();
    expect(props.practice).toBe(true);
    expect(hasBanner(Document(props as never))).toBe(true);
  });
  it("and not otherwise", async () => {
    process.env.DATABASE_URL = LIVE;
    const props = await initial();
    expect(props.practice).toBe(false);
    expect(hasBanner(Document(props as never))).toBe(false);
  });
});

describe("what it says", () => {
  it("says it's practice, and that nothing real happens", () => {
    const html = renderToStaticMarkup(PracticeBanner());
    expect(html).toMatch(/Practice copy/);
    expect(html).toMatch(/no card is charged/);
    expect(html).toMatch(/no message is sent/);
  });
});

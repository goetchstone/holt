// /app/__tests__/documentNonce.test.ts
//
// The Pages Router sign-in screens run only if pages/_document.tsx hands the
// request's nonce (x-nonce, set by src/proxy.ts) to <Head> and <NextScript>.
// Next stamps the Pages Router's scripts from those props alone, and the page
// policy blocks every unstamped script, so without them nobody can sign in. The
// browser sweep opens the screens for real (e2e/pages.spec.ts); this holds the
// plumbing in the unit suite, the way practiceBanner.test.ts holds the banner.

jest.mock("@/lib/appSettings", () => ({
  getAppSettings: jest.fn().mockResolvedValue({ theme: null, faviconUrl: null }),
  themeToCssVars: jest.fn().mockReturnValue(""),
}));
jest.mock("next/document", () => ({
  Html: () => null,
  Head: () => null,
  Main: () => null,
  NextScript: () => null,
}));

import { Children, isValidElement, type ReactNode } from "react";
import Document from "@/pages/_document";

// The mocked components, to find in the tree _document returns. Taken from the
// mock registry: only pages/_document.tsx may import next/document.
const { Head, NextScript } = jest.requireMock<{ Head: unknown; NextScript: unknown }>(
  "next/document",
);

type GetInitialProps = (ctx: unknown) => Promise<{ nonce?: string }>;
const getInitialProps = (Document as unknown as { getInitialProps: GetInitialProps })
  .getInitialProps;

/** The `nonce` prop of every element of `type` in the tree. */
function noncesOf(node: ReactNode, type: unknown): (string | undefined)[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode; nonce?: string }>(child)) return [];
    const own = child.type === type ? [child.props.nonce] : [];
    return [...own, ...noncesOf(child.props.children, type)];
  });
}

async function documentFor(headers: Record<string, string>) {
  const props = await getInitialProps({
    req: { headers },
    defaultGetInitialProps: async () => ({ html: "" }),
  });
  return { props, tree: Document(props as never) };
}

describe("pages/_document.tsx passes the request's nonce", () => {
  it("gives <Head> and <NextScript> the x-nonce the proxy set", async () => {
    const { props, tree } = await documentFor({ "x-nonce": "bm9uY2U=" });
    expect(props.nonce).toBe("bm9uY2U=");
    expect(noncesOf(tree, Head)).toEqual(["bm9uY2U="]);
    expect(noncesOf(tree, NextScript)).toEqual(["bm9uY2U="]);
  });

  it("passes no nonce when the request carries none", async () => {
    const { props } = await documentFor({});
    expect(props.nonce).toBeUndefined();
  });
});

// /app/src/pages/_document.tsx
//
// The document for the Pages Router screens (/auth/*). `nonce` is required for
// them to run at all: src/proxy.ts sends a nonce Content-Security-Policy, and
// Next stamps the Pages Router's own scripts (its chunks and the inline
// Turbopack bootstrap) only with the nonce passed to <Head> and <NextScript>.
// Without it every script on the sign-in screens is blocked and nobody can
// sign in. The App Router stamps its scripts by itself.

import { Html, Head, Main, NextScript } from "next/document";
import type { DocumentContext, DocumentInitialProps } from "next/document";
import { getAppSettings, themeToCssVars } from "@/lib/appSettings";
import { isPracticeCopy } from "@/lib/practiceCopy";
import { PracticeBanner } from "@/components/PracticeBanner";

interface HoltDocumentProps extends DocumentInitialProps {
  themeCss: string;
  faviconUrl: string | null;
  practice: boolean;
  /** This request's script nonce, from src/proxy.ts. Absent on a page built ahead of time. */
  nonce: string | undefined;
}

export default function Document({ themeCss, faviconUrl, practice, nonce }: HoltDocumentProps) {
  return (
    <Html>
      <Head nonce={nonce}>
        {process.env.NEXT_PUBLIC_FONT_CSS_URL ? (
          <link rel="stylesheet" href={process.env.NEXT_PUBLIC_FONT_CSS_URL} />
        ) : null}
        {faviconUrl ? <link rel="icon" href={faviconUrl} /> : null}
        {themeCss ? <style dangerouslySetInnerHTML={{ __html: themeCss }} /> : null}
      </Head>
      <body>
        {practice ? <PracticeBanner /> : null}
        <Main />
        <NextScript nonce={nonce} />
      </body>
    </Html>
  );
}

Document.getInitialProps = async (ctx: DocumentContext): Promise<HoltDocumentProps> => {
  const initialProps = await ctx.defaultGetInitialProps(ctx);
  const settings = await getAppSettings();
  const nonce = ctx.req?.headers["x-nonce"];
  return {
    ...initialProps,
    themeCss: themeToCssVars(settings.theme),
    faviconUrl: settings.faviconUrl,
    practice: isPracticeCopy(),
    nonce: typeof nonce === "string" ? nonce : undefined,
  };
};

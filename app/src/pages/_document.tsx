// /app/src/pages/_document.tsx

import { Html, Head, Main, NextScript } from "next/document";
import type { DocumentContext, DocumentInitialProps } from "next/document";
import { getAppSettings, themeToCssVars } from "@/lib/appSettings";

interface HoltDocumentProps extends DocumentInitialProps {
  themeCss: string;
  faviconUrl: string | null;
}

export default function Document({ themeCss, faviconUrl }: HoltDocumentProps) {
  return (
    <Html>
      <Head>
        {process.env.NEXT_PUBLIC_FONT_CSS_URL ? (
          <link rel="stylesheet" href={process.env.NEXT_PUBLIC_FONT_CSS_URL} />
        ) : null}
        {faviconUrl ? <link rel="icon" href={faviconUrl} /> : null}
        {themeCss ? <style dangerouslySetInnerHTML={{ __html: themeCss }} /> : null}
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

Document.getInitialProps = async (ctx: DocumentContext): Promise<HoltDocumentProps> => {
  const initialProps = await ctx.defaultGetInitialProps(ctx);
  const settings = await getAppSettings();
  return {
    ...initialProps,
    themeCss: themeToCssVars(settings.theme),
    faviconUrl: settings.faviconUrl,
  };
};

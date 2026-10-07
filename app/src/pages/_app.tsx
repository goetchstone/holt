// /app/src/pages/_app.tsx

import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { SessionProvider } from "next-auth/react";
import { ToastContainer } from "react-toastify";
import FeedbackButton from "@/components/FeedbackButton";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import ErrorBoundary from "@/components/ErrorBoundary";
import { BrandingProvider } from "@/components/branding/BrandingProvider";

export default function MyApp({
  Component,
  pageProps: { session, branding, ...pageProps },
}: AppProps) {
  return (
    <SessionProvider session={session}>
      <BrandingProvider value={branding}>
        <ErrorBoundary>
          <ImpersonationBanner />
          <Component {...pageProps} />
          <FeedbackButton />
          <ToastContainer position="top-center" autoClose={5000} hideProgressBar={false} />
        </ErrorBoundary>
      </BrandingProvider>
    </SessionProvider>
  );
}

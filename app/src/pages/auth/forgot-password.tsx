// /app/src/pages/auth/forgot-password.tsx

import { useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Button } from "@/components/ui/button";
import { getPublicBranding } from "@/lib/appSettings";
import { useBranding } from "@/components/branding/BrandingProvider";

// Public page (part of the sign-in flow). Only reachable when local accounts
// are enabled; otherwise it 404s like the API behind it would.
export const getServerSideProps: GetServerSideProps = async () => {
  if (!process.env.AUTH_LOCAL_ENABLED) {
    return { notFound: true };
  }
  return { props: { branding: await getPublicBranding() } };
};

export default function ForgotPassword() {
  const branding = useBranding();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } finally {
      // The API always answers ok (no account enumeration) — mirror that here.
      setSent(true);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-sh-linen px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-lg">
        <div className="mb-6 flex justify-center">
          <BrandLogo
            appName={branding.appName}
            logoUrl={branding.loginLogoUrl ?? branding.logoUrl}
            className="h-14 w-auto"
            wordmarkClassName="font-serif text-3xl font-semibold text-sh-navy"
          />
        </div>

        {sent ? (
          <p className="text-center text-sm text-sh-gray">
            If an account exists for that email, a reset link is on its way. The link works once and
            expires in 1 hour.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <p className="text-sm text-sh-gray">
              Enter your account email and we&apos;ll send a password-reset link.
            </p>
            <div>
              <label htmlFor="fp-email" className="mb-1 block text-sm font-medium text-sh-navy">
                Email
              </label>
              <input
                id="fp-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-[44px] w-full rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
              />
            </div>
            <Button type="submit" fullWidth disabled={submitting}>
              {submitting ? "Sending..." : "Send reset link"}
            </Button>
          </form>
        )}

        <p className="mt-4 text-center text-sm">
          <Link href="/auth/login" className="text-sh-navy hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
